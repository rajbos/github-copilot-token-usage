#!/usr/bin/env node

/**
 * Desktop App Webview Message Contract Validation
 *
 * The desktop app (desktop/) reuses the VS Code extension's webview bundles
 * verbatim, but answers their messages with its own hand-written switch in
 * `registerIpcHandlers` (desktop/src/main.ts). A button added to a shared view
 * therefore lands in the desktop app as a control that does nothing when
 * clicked — nothing fails to compile and `npm run check:contract` (which only
 * looks at the extension host) stays green.
 *
 * This script closes that gap. For every view the desktop bundles
 * (`WEBVIEW_BUNDLES` in desktop/esbuild.js), it walks the view's import graph
 * from `vscode-extension/src/webview/<view>/main.ts`, collects every `command`
 * the view can post, and requires each one to be either:
 *
 *   - handled in desktop/src/main.ts, or
 *   - listed in desktop/src/unsupportedWebviewCommands.json with a reason and a
 *     status: 'hidden' (with the CSS selectors that hide its controls), 'gap'
 *     (the control is still visible and dead — recorded, not decided) or
 *     'no-op' (a background notice with no control, safe to ignore).
 *
 * The same JSON drives the hidden-controls CSS in main.ts, so the list of
 * hidden controls and the list of unhandled commands cannot drift apart. The
 * check also fails on stale entries — a command that is now handled, or no
 * longer posted by any desktop view, or a selector whose id/class no longer
 * appears in the views' sources — so the list shrinks as gaps are closed.
 *
 * Usage:
 *   node scripts/validate-desktop-contract.js [--json]
 *
 * Exits 1 on any finding, 2 on a configuration error.
 */

const fs = require('fs');
const path = require('path');
const { collectPostedCommands, ts } = require('./validate-webview-contract.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const DESKTOP_DIR = path.join(REPO_ROOT, 'desktop');
const EXT_WEBVIEW_DIR = path.join(REPO_ROOT, 'vscode-extension', 'src', 'webview');
const DESKTOP_MAIN = path.join(DESKTOP_DIR, 'src', 'main.ts');
const UNSUPPORTED_FILE = path.join(DESKTOP_DIR, 'src', 'unsupportedWebviewCommands.json');
const IPC_HANDLER_FUNCTION = 'registerIpcHandlers';

const STATUSES = ['hidden', 'gap', 'no-op'];

class ConfigError extends Error {}

/** View names the desktop app bundles, from `WEBVIEW_BUNDLES` in desktop/esbuild.js. */
function readDesktopViews() {
  const src = fs.readFileSync(path.join(DESKTOP_DIR, 'esbuild.js'), 'utf8');
  const block = src.match(/const\s+WEBVIEW_BUNDLES\s*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    throw new ConfigError('Could not find WEBVIEW_BUNDLES in desktop/esbuild.js — has it moved?');
  }
  const views = [...block[1].matchAll(/['"]([\w-]+)\.js['"]/g)].map((m) => m[1]);
  if (views.length === 0) {
    throw new ConfigError('WEBVIEW_BUNDLES in desktop/esbuild.js lists no bundles.');
  }
  return views;
}

/** Resolves a relative import specifier to a .ts file, or undefined for non-TS targets. */
function resolveImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Every .ts file reachable from `entry` through relative imports — the
 * sources esbuild compiles into that view's bundle. Shared webview helpers
 * only count for the views that actually import them.
 */
function collectViewFiles(entry) {
  const seen = new Set();
  const stack = [entry];
  const importPattern = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(importPattern)) {
      const resolved = resolveImport(file, match[1] || match[2] || match[3]);
      if (resolved && !seen.has(resolved)) {
        stack.push(resolved);
      }
    }
  }
  return [...seen];
}

/** `file#function:expression` -> reason, for computed command names the check cannot resolve and a human has reviewed. */
function readUnresolvedComputedCommands() {
  const parsed = JSON.parse(fs.readFileSync(UNSUPPORTED_FILE, 'utf8'));
  const declared = parsed.unresolvedComputedCommands || {};
  for (const [key, reason] of Object.entries(declared)) {
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new ConfigError(`unsupportedWebviewCommands.json: unresolvedComputedCommands '${key}' needs a non-empty reason.`);
    }
  }
  return declared;
}

function readUnsupported() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(UNSUPPORTED_FILE, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Cannot read ${path.relative(REPO_ROOT, UNSUPPORTED_FILE)}: ${e.message}`);
  }
  const commands = parsed.commands || {};
  for (const [command, entry] of Object.entries(commands)) {
    const where = `unsupportedWebviewCommands.json: '${command}'`;
    if (!entry || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new ConfigError(`${where} needs a non-empty "reason".`);
    }
    if (!STATUSES.includes(entry.status)) {
      throw new ConfigError(`${where} has status '${entry.status}'; expected one of ${STATUSES.join(', ')}.`);
    }
    const hidden = Array.isArray(entry.hiddenBy) && entry.hiddenBy.length > 0;
    if ((entry.status === 'hidden') !== hidden) {
      throw new ConfigError(`${where}: "hiddenBy" selectors are required for status 'hidden' and not allowed otherwise.`);
    }
    entry.hiddenBy = entry.hiddenBy || [];
  }
  return commands;
}

/** The identifier a simple `#id` / `.class` selector targets, as it would appear in source. */
/** Removes wrapping parentheses, `as` casts and `!` assertions. */
function unwrapExpression(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The `data-*` attribute name read by `x.getAttribute('data-…')` (also through `?? ''` / `|| ''`), if that is what `node` is. */
function dataAttributeRead(node) {
  let expr = unwrapExpression(node);
  if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(expr.operatorToken.kind)) {
    expr = unwrapExpression(expr.left);
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'getAttribute' &&
    expr.arguments.length === 1 &&
    ts.isStringLiteralLike(expr.arguments[0]) &&
    expr.arguments[0].text.startsWith('data-')
  ) {
    return expr.arguments[0].text;
  }
  return undefined;
}

/** The initializer of the nearest `const|let name = …` visible from `node`, walking outwards through enclosing blocks. */
function findLocalInitializer(node, name) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : [];
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
          return declaration.initializer;
        }
      }
    }
  }
  return undefined;
}

/** The string literals of a `name: 'a' | 'b'` parameter of the nearest enclosing function that declares `name`, if typed that way. */
function literalUnionParameter(node, name) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) {
      continue;
    }
    const param = current.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
    if (!param) {
      continue;
    }
    const types = param.type && ts.isUnionTypeNode(param.type) ? param.type.types : param.type ? [param.type] : [];
    const literals = types.map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : undefined));
    return types.length > 0 && literals.every(Boolean) ? new Set(literals) : undefined;
  }
  return undefined;
}

/** Name of the nearest enclosing named function or method, for a stable, readable site key. */
function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText();
    }
  }
  return '<module>';
}

/** The `.class` of the nearest enclosing `document.querySelector(All)('.class')…` the handler is attached through, if any. */
function enclosingClassSelector(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
      continue;
    }
    const receiver = unwrapExpression(current.expression.expression);
    if (
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      /^querySelector(All)?$/.test(receiver.expression.name.text) &&
      receiver.arguments.length === 1 &&
      ts.isStringLiteralLike(receiver.arguments[0])
    ) {
      const match = receiver.arguments[0].text.trim().match(/^\.([\w-]+)$/);
      return match ? match[1] : undefined;
    }
  }
  return undefined;
}

/**
 * Values of `attribute="…"` in the markup of `texts`, limited to tags whose
 * class list contains `className` when one is given. This is how a computed
 * command such as `{ command: action }`, with `action` read from the clicked
 * button's `data-action`, is turned back into the finite set of names it can be.
 */
function attributeValuesInMarkup(texts, attribute, className) {
  const values = new Set();
  const valuePattern = new RegExp(`\\b${attribute}="([\\w-]+)"`);
  const classPattern = className ? new RegExp(`\\bclass="[^"]*(^|[\\s"])${className}([\\s"]|$)`) : undefined;
  for (const text of texts) {
    for (const [tag] of text.matchAll(/<[a-zA-Z][\w-]*\s[^<>]*>/g)) {
      const value = tag.match(valuePattern);
      if (value && (!classPattern || classPattern.test(tag.replace(/class="([^"]*)"/, 'class=" $1 "')))) {
        values.add(value[1]);
      }
    }
  }
  return values;
}

/**
 * Commands a view posts under a name computed at runtime, which the literal
 * scan in validate-webview-contract.js skips. A `{ command: x }` whose `x` is
 * read from a `data-*` attribute is resolved from the view's markup (scoped to
 * the class the click handler is attached through); one that is a parameter
 * typed as a union of string literals resolves to those literals. Anything
 * else is returned in `unresolved`, so it cannot pass silently.
 *
 * @returns {{ posted: Map<string, {file: string, line: number}[]>, unresolved: {key: string, file: string, line: number}[] }}
 */
function collectComputedPostedCommands(files) {
  const posted = new Map();
  const unresolved = [];
  const texts = files.map((f) => fs.readFileSync(f, 'utf8'));

  files.forEach((file, index) => {
    const sourceFile = ts.createSourceFile(file, texts[index], ts.ScriptTarget.Latest, true);
    const relativeFile = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const visit = (node) => {
      if (ts.isCallExpression(node) && /(^|\.)postMessage$/.test(node.expression.getText(sourceFile))) {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) {
            continue;
          }
          for (const prop of arg.properties) {
            const key = prop.name && prop.name.getText(sourceFile).replace(/['"]/g, '');
            if (key !== 'command' && key !== 'type') {
              continue;
            }
            const value = ts.isShorthandPropertyAssignment(prop) ? prop.name : ts.isPropertyAssignment(prop) ? unwrapExpression(prop.initializer) : undefined;
            if (!value || ts.isStringLiteralLike(value)) {
              continue; // literal names are the shared collector's job
            }
            const line = sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile)).line + 1;
            const initializer = ts.isIdentifier(value) ? findLocalInitializer(node, value.text) : value;
            const attribute = initializer ? dataAttributeRead(initializer) : undefined;
            const names = attribute
              ? attributeValuesInMarkup(texts, attribute, enclosingClassSelector(node))
              : (!initializer && ts.isIdentifier(value) && literalUnionParameter(node, value.text)) || new Set();
            if (names.size === 0) {
              unresolved.push({
                key: `${relativeFile}#${enclosingFunctionName(node)}:${value.getText(sourceFile)}`,
                file: relativeFile,
                line,
              });
              continue;
            }
            for (const name of names) {
              if (!posted.has(name)) {
                posted.set(name, []);
              }
              posted.get(name).push({ file: relativeFile, line });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  });

  return { posted, unresolved };
}

/** Views whose bundled sources mention `token` as a whole word (id or class name). */
function viewsMentioning(token, viewTexts) {
  const pattern = new RegExp(`(^|[^\\w-])${token}([^\\w-]|$)`);
  return [...viewTexts].filter(([, text]) => pattern.test(text)).map(([view]) => view).sort();
}

/**
 * Views a hidden selector reaches that do not post the command it is listed
 * under. Desktop CSS applies to every panel, so a class shared across views
 * (`.share-btn` on both Diagnostics and Fluency Score) would also hide another
 * view's controls — which then disappear or reappear with an unrelated entry.
 *
 * `viewOwnTexts` holds only each view's own directory: shared modules such as
 * the nav-button registry list every id for every view, so counting them would
 * report views that never render the control.
 */
function selectorOverreach(token, postedBy, viewOwnTexts) {
  return viewsMentioning(token, viewOwnTexts).filter((view) => !postedBy.has(view));
}

function selectorToken(selector) {
  const match = selector.trim().match(/^[#.]([\w-]+)$/);
  return match ? match[1] : undefined;
}

/**
 * Commands the desktop answers: the `case` labels of `switch (….command)` and
 * `….command === '…'` comparisons inside `registerIpcHandlers` only. The
 * extension's collector scans a whole file and also counts the keys of any
 * `Record<string, …>` object; over main.ts that would let an unrelated map
 * (STATIC_MIME_TYPES, say) mark a posted command as handled.
 *
 * A branch that does nothing — `case 'x': break;` (after following
 * fall-through) or `if (….command === 'x') {}` — is returned in `bare`, not
 * `handled`: it looks like a handler but the message is still dropped, so it
 * must be implemented or listed in unsupportedWebviewCommands.json.
 */
function collectIpcDispatch(file = DESKTOP_MAIN) {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let handlerFn;
  const findHandler = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === IPC_HANDLER_FUNCTION) {
      handlerFn = node;
      return;
    }
    ts.forEachChild(node, findHandler);
  };
  findHandler(sourceFile);
  if (!handlerFn) {
    throw new ConfigError(`Could not find function ${IPC_HANDLER_FUNCTION} in ${path.relative(REPO_ROOT, file)} — has it moved or been renamed?`);
  }

  const handled = new Set();
  const bare = new Set();
  const isCommandAccess = (expr) => /\.command$/.test(expr.getText(sourceFile));
  /** A body that does nothing: only `break;` / `;` statements (comments are not statements). */
  const isNoOpStatements = (statements) =>
    statements.every((st) => ts.isBreakStatement(st) || ts.isEmptyStatement(st) || (ts.isBlock(st) && isNoOpStatements(st.statements)));
  const visit = (node) => {
    if (ts.isSwitchStatement(node) && isCommandAccess(node.expression)) {
      const clauses = node.caseBlock.clauses;
      clauses.forEach((clause, i) => {
        if (!ts.isCaseClause(clause) || !ts.isStringLiteralLike(clause.expression)) {
          return;
        }
        // Follow fall-through (`case 'a': case 'b': run();`) to the clause that has a body.
        const body = clauses.slice(i).find((c) => c.statements.length > 0);
        (body && !isNoOpStatements(body.statements) ? handled : bare).add(clause.expression.text);
      });
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      isCommandAccess(node.left) &&
      ts.isStringLiteralLike(node.right)
    ) {
      const guarded = ts.isIfStatement(node.parent) && node.parent.expression === node ? node.parent.thenStatement : undefined;
      (guarded && isNoOpStatements([guarded]) ? bare : handled).add(node.right.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(handlerFn);
  if (handled.size === 0) {
    throw new ConfigError(`${IPC_HANDLER_FUNCTION} handles no commands — has its dispatch changed shape?`);
  }
  // A command with a real branch anywhere counts as handled.
  for (const command of handled) {
    bare.delete(command);
  }
  return { handled, bare };
}

/** Commands `registerIpcHandlers` actually acts on (bare `case 'x': break;` branches excluded). */
function collectIpcHandledCommands(file = DESKTOP_MAIN) {
  return collectIpcDispatch(file).handled;
}

function analyse() {
  const views = readDesktopViews();
  const unsupported = readUnsupported();
  const { handled, bare } = collectIpcDispatch();

  /** command -> { views: Set, locations: [] } */
  const posted = new Map();
  /** view -> the text of every source file in its bundle */
  const viewTexts = new Map();
  /** view -> the text of the bundle's files under the view's own directory */
  const viewOwnTexts = new Map();
  /** postMessage sites whose command name could not be resolved statically */
  const unresolvedSites = [];
  for (const view of views) {
    const entry = path.join(EXT_WEBVIEW_DIR, view, 'main.ts');
    if (!fs.existsSync(entry)) {
      throw new ConfigError(`Desktop bundles '${view}.js' but ${path.relative(REPO_ROOT, entry)} does not exist.`);
    }
    const files = collectViewFiles(entry);
    viewTexts.set(view, files.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
    const viewDir = path.join(EXT_WEBVIEW_DIR, view) + path.sep;
    viewOwnTexts.set(view, files.filter((f) => f.startsWith(viewDir)).map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
    const computed = collectComputedPostedCommands(files);
    for (const site of computed.unresolved) {
      if (!unresolvedSites.some((s) => s.key === site.key)) {
        unresolvedSites.push(site);
      }
    }
    for (const [command, locations] of [...collectPostedCommands(files), ...computed.posted]) {
      if (!posted.has(command)) {
        posted.set(command, { views: new Set(), locations: [] });
      }
      const record = posted.get(command);
      record.views.add(view);
      for (const loc of locations) {
        if (!record.locations.some((l) => l.file === loc.file && l.line === loc.line)) {
          record.locations.push(loc);
        }
      }
    }
  }

  const findings = [];

  const declaredUnresolved = readUnresolvedComputedCommands();
  for (const site of unresolvedSites) {
    if (Object.prototype.hasOwnProperty.call(declaredUnresolved, site.key)) {
      continue;
    }
    findings.push({
      kind: 'computed',
      command: site.key,
      locations: [{ file: site.file, line: site.line }],
      detail:
        'posts a command whose name is computed at runtime and could not be resolved to a fixed set, so the desktop ' +
        'contract cannot see which commands it sends. Post literal command names, read the name from a data-* ' +
        'attribute rendered with literal values, or list this site under "unresolvedComputedCommands" in ' +
        'unsupportedWebviewCommands.json with a reason.',
    });
  }
  for (const key of Object.keys(declaredUnresolved)) {
    if (!unresolvedSites.some((s) => s.key === key)) {
      findings.push({
        kind: 'stale',
        command: key,
        detail: 'is listed under "unresolvedComputedCommands" but no such unresolved postMessage site exists any more — remove it',
      });
    }
  }

  for (const [command, { views: postedBy, locations }] of [...posted].sort(([a], [b]) => a.localeCompare(b))) {
    if (handled.has(command) || Object.prototype.hasOwnProperty.call(unsupported, command)) {
      continue;
    }
    findings.push({
      kind: 'unhandled',
      command,
      locations,
      detail:
        `posted by the ${[...postedBy].sort().join(', ')} view(s), but desktop/src/main.ts has no handler` +
        (bare.has(command) ? ' (only a branch that does nothing, such as a bare `case` with `break`)' : '') +
        ' — ' +
        'the control does nothing in the desktop app. Handle it in registerIpcHandlers, or list it in ' +
        'desktop/src/unsupportedWebviewCommands.json with a status and reason.',
    });
  }

  for (const [command, entry] of Object.entries(unsupported).sort(([a], [b]) => a.localeCompare(b))) {
    if (handled.has(command)) {
      findings.push({
        kind: 'stale',
        command,
        detail: 'is handled in desktop/src/main.ts now — remove it (and its hidden selectors) from unsupportedWebviewCommands.json',
      });
    } else if (!posted.has(command)) {
      findings.push({
        kind: 'stale',
        command,
        detail: 'is no longer posted by any view the desktop bundles — remove it from unsupportedWebviewCommands.json',
      });
    }
    for (const selector of entry.hiddenBy) {
      const token = selectorToken(selector);
      if (!token) {
        findings.push({
          kind: 'selector',
          command,
          detail: `hides '${selector}', which is not a simple #id or .class selector the check can verify`,
        });
      } else if (viewsMentioning(token, viewTexts).length === 0) {
        findings.push({
          kind: 'selector',
          command,
          detail: `hides '${selector}', but '${token}' no longer appears in the desktop views' sources — the selector hides nothing`,
        });
      } else {
        const overreach = selectorOverreach(token, posted.get(command)?.views ?? new Set(), viewOwnTexts);
        if (overreach.length > 0) {
          findings.push({
            kind: 'selector',
            command,
            detail:
              `hides '${selector}', which also appears in the ${overreach.join(', ')} view(s) that do not post '${command}' — ` +
              "it would hide their controls too. Use a selector specific to this command's controls.",
          });
        }
      }
    }
  }

  return {
    views,
    postedCount: posted.size,
    handled: [...posted.keys()].filter((c) => handled.has(c)).sort(),
    knownGaps: Object.entries(unsupported)
      .filter(([, e]) => e.status === 'gap')
      .map(([c]) => c)
      .sort(),
    findings,
  };
}

function annotate(finding) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return;
  }
  const where = finding.locations?.[0];
  const file = where ? where.file : path.relative(REPO_ROOT, UNSUPPORTED_FILE);
  const line = where ? where.line : 1;
  console.log(`::error file=${file},line=${line}::${`desktop: '${finding.command}' ${finding.detail}`.replace(/\n/g, '%0A')}`);
}

function main() {
  let result;
  try {
    result = analyse();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`❌ ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: result.findings.length === 0, ...result }, null, 2));
    process.exit(result.findings.length === 0 ? 0 : 1);
  }

  console.log('🔌 Desktop app webview message contract\n');
  console.log(`   Views bundled: ${result.views.join(', ')}`);
  console.log(`   Commands posted: ${result.postedCount}, handled by the desktop: ${result.handled.length}`);
  if (result.knownGaps.length > 0) {
    console.log(`   ⚠️  Known gaps (visible, unhandled): ${result.knownGaps.join(', ')}`);
  }
  console.log('');

  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      console.error(`❌ '${finding.command}' ${finding.detail}`);
      for (const location of finding.locations || []) {
        console.error(`     posted at ${location.file}:${location.line}`);
      }
      annotate(finding);
    }
    console.error('\n❌ Desktop webview message contract validation failed!\n');
    process.exit(1);
  }

  console.log('✅ Every message a desktop view can post is handled or explicitly listed as unsupported.\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { readDesktopViews, collectViewFiles, collectIpcHandledCommands, collectComputedPostedCommands, selectorOverreach, analyse };
