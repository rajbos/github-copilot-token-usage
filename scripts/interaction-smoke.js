#!/usr/bin/env node
'use strict';

/**
 * Interaction smoke test for the extension's webview panels.
 *
 * `validate-webview-contract.js` proves that every command a bundle *can* post
 * has a handler. It cannot prove the button is wired to post anything at all —
 * a `<button>` that nobody called `addEventListener` on is, to a static
 * checker, indistinguishable from a decorative element. That is the other half
 * of the bug class this repo keeps hitting after a PR burst: the handler is
 * fine, the markup is fine, and the click goes nowhere.
 *
 * So this script clicks. It reuses the visual-view-diff harness to render the
 * *real* webview bundles headlessly (never the Extension Development Host —
 * see "Never Launch a Real Editor/IDE Instance" in AGENTS.md), enumerates every
 * interactive control, clicks each one, and records what happened:
 *
 *   - a `postMessage` to the host          -> wired
 *   - a DOM change                         -> wired (client-side only)
 *   - neither, and no error                -> DEAD CONTROL (finding)
 *   - a thrown error                       -> BROKEN CONTROL (finding)
 *   - a command with no host handler       -> UNHANDLED COMMAND (finding)
 *
 * The last one catches what the static check cannot: a command name computed at
 * runtime (`{ command: someVar }`) that resolves to something nobody handles.
 *
 * One exception: a control that is *already selected* (the `.active` button in
 * a segmented group, a checked radio) is supposed to do nothing when clicked
 * again, so a no-op there is reported as `noop-selected`, not as a finding.
 * That does mean a genuinely dead default button hides here — the same
 * deliberate trade the contract checker makes, because the alternative is three
 * standing false positives on the chart view and a check nobody trusts.
 *
 * Two things the click pass cannot reach: a `<select>`, which is changed rather
 * than clicked, and a control that only exists after some other control was
 * used. A view can therefore declare `scenarios` in views.config.json — scripted
 * click/select steps replayed on a fresh page, each step asserting that the view
 * still renders what the scenario says it must. That is how the Models tab's
 * mode/window/model pickers are covered: every offered combination has to keep
 * producing a comparison, not an empty side.
 *
 * Controls are clicked in one pass over a single page, so a click that opens a
 * dialog can hide later controls. Those are reported as `skipped`, never as
 * failures — use `--isolate` to reload the page between clicks when a view's
 * results look polluted.
 *
 * Usage:
 *   node scripts/interaction-smoke.js [--view details,chart] [--isolate]
 *                                     [--json] [--out <file>] [--concurrency <n>]
 *
 * `--concurrency` is how many views are exercised at once (default 4). The
 * report is always in registry order.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_DIR = path.join(__dirname, '..', '.github', 'skills', 'visual-view-diff');
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'vscode-extension', 'dist', 'webview');

const { buildPageHtml, loadFixture } = require(path.join(SKILL_DIR, 'lib', 'harness.js'));
const { loadChromium } = require(path.join(SKILL_DIR, 'lib', 'browser.js'));
const { parseArgs, readConfig, selectViews } = require(path.join(SKILL_DIR, 'lib', 'config.js'));
// The step vocabulary (`click`, `select`, `post`) is shared with the visual
// diff's `states`, so a scenario and a screenshot state read alike. The
// `select` picking stays inline here because this runner also has to tell a
// legitimate no-op (nothing else to select) from a change.
const { PICK_OPTION, applyStep, describeStep } = require(path.join(SKILL_DIR, 'lib', 'steps.js'));
const { parseConcurrency, runPool } = require(path.join(SKILL_DIR, 'lib', 'pool.js'));

const { collectHandledCommandsFromAst, widenHandledFromText, collectTsFiles } = require('./validate-webview-contract.js');

/**
 * What counts as a control a user can click. Kept deliberately broad — a false
 * "dead control" on a decorative element is cheap to allow-list, while missing
 * a real dead button is the whole reason this exists.
 */
const INTERACTIVE_SELECTOR = [
  'button',
  '[role="button"]',
  '[data-action]',
  '[data-command]',
  '[data-tab]',
  '.tab',
  '.clickable',
  'summary',
  'a[href^="#"]',
  'a[href^="command:"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  // A <select> is never "clicked" into a new value by Playwright's click — the
  // native picker is not part of the page — so it needs the change-event path
  // below. Without it, every dropdown in the extension (chart filters, the
  // Efficiency scope toolbar) ships silently unvalidated.
  'select',
].join(', ');

/** Reads the extension-side handled-command set once, for the unhandled check. */
function loadHandledCommands() {
  const extDir = path.join(REPO_ROOT, 'vscode-extension', 'src');
  const webviewDir = path.join(extDir, 'webview');
  const extensionFiles = collectTsFiles(extDir).filter((f) => !f.startsWith(webviewDir + path.sep));
  return widenHandledFromText(extensionFiles, collectHandledCommandsFromAst(extensionFiles));
}

/**
 * Runs inside the page: tags every visible, enabled control with a stable index
 * and returns a short description of each, so the driver can click by index
 * even after the DOM around it has shifted.
 */
/**
 * Installed on every page before its scripts run, so the control crawl and a
 * scenario's `expect` agree on what "showing" means. An element that is in the
 * DOM but `display:none`, `visibility:hidden`, or zero-sized is not showing —
 * checking presence alone would let a scenario pass on a view that had gone
 * blank.
 */
const INSTALL_VISIBILITY_HELPER = () => {
  window.__SMOKE_IS_VISIBLE__ = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
};

const TAG_CONTROLS = (selector) => {
  // Clickability is visibility plus pointer events: a control behind
  // `pointer-events: none` is visible but cannot be clicked.
  const isVisible = (el) =>
    window.__SMOKE_IS_VISIBLE__(el) && window.getComputedStyle(el).pointerEvents !== 'none';

  const controls = [];
  const seen = new Map();
  let index = 0;
  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      continue;
    }
    if (!isVisible(el)) {
      continue;
    }
    // For a <select>, find a value other than the current one so the driver can
    // change it; a select with one usable option has nothing to exercise. This
    // runs *before* the id is assigned, so a skipped select never leaves a
    // stale `data-smoke-id` for the next control's index to collide with.
    let selectValue = null;
    if (el instanceof HTMLSelectElement) {
      const option = Array.from(el.options).find((o) => !o.disabled && o.value !== el.value);
      if (!option) {
        continue;
      }
      selectValue = option.value;
    }
    el.setAttribute('data-smoke-id', String(index));
    const label = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    // Identity, not position: a control that re-renders its view can add or
    // remove controls around this one, and matching the fresh enumeration by
    // array index would then silently exercise a different control.
    //
    // Built from stable attributes first. A <select>'s textContent is the
    // concatenation of all its option labels, so it changes whenever a rerender
    // prunes or refills the options — including it would make the control
    // unfindable on the next pass and silently skip it, the exact failure this
    // identity exists to prevent. Text is therefore only a last resort, and
    // never for a <select>.
    const tag = el.tagName.toLowerCase();
    const stable =
      el.id ||
      el.getAttribute('name') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('data-tab') ||
      el.getAttribute('data-action') ||
      el.getAttribute('data-command') ||
      el.getAttribute('data-range') ||
      '';
    const identity = [tag, stable, stable || tag === 'select' ? '' : label].join('|');
    const occurrence = seen.get(identity) || 0;
    seen.set(identity, occurrence + 1);
    const key = `${identity}#${occurrence}`;
    // A segmented control's current option, a checked radio: re-clicking it is
    // meant to be inert, so a no-op there is not evidence of broken wiring.
    const alreadySelected =
      el.classList.contains('active') ||
      el.classList.contains('selected') ||
      el.getAttribute('aria-pressed') === 'true' ||
      el.getAttribute('aria-selected') === 'true' ||
      (el instanceof HTMLInputElement && el.type === 'radio' && el.checked);
    controls.push({
      index,
      tag,
      id: el.id || null,
      classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 80) : null,
      label: label || null,
      alreadySelected,
      selectValue,
      key,
    });
    index++;
  }
  return controls;
};

/**
 * Runs inside the page: a fingerprint of the rendered DOM with focus state
 * stripped out.
 *
 * Clicking anything moves focus, and focus is visible in the markup — the
 * `vscode-button` web component carries a `focused` attribute, browsers add
 * `:focus-visible` classes. Hashing raw `innerHTML` therefore reports a DOM
 * change for *every* click, including clicks on buttons that do nothing at all.
 * That is a false negative in the direction that matters: a dead control scored
 * as wired. So normalize the focus artifacts away before hashing.
 */
const DOM_SIGNATURE = () => {
  const clone = document.body.cloneNode(true);
  const FOCUS_ATTRS = ['focused', 'autofocus', 'aria-activedescendant', 'data-smoke-id'];
  const FOCUS_CLASSES = ['focused', 'focus-visible', 'focus', 'hover', 'hovered'];
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    for (const attr of FOCUS_ATTRS) {
      el.removeAttribute(attr);
    }
    for (const cls of FOCUS_CLASSES) {
      el.classList.remove(cls);
    }
    if (el.getAttribute('class') === '') {
      el.removeAttribute('class');
    }
  }
  const html = clone.innerHTML;
  let hash = 0;
  for (let i = 0; i < html.length; i++) {
    hash = (hash * 31 + html.charCodeAt(i)) | 0;
  }
  return `${html.length}:${hash}`;
};

/** Writes the view's standalone page to a temp dir and returns both paths. */
function preparePage(view, fixturePath, bundlePath) {
  const html = buildPageHtml({
    globalName: view.global,
    fixture: loadFixture(fixturePath, REPO_ROOT),
    theme: 'dark',
    bundlePath,
    repoRoot: REPO_ROOT,
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-smoke-'));
  const pageFile = path.join(tmpDir, `${view.id}.html`);
  fs.writeFileSync(pageFile, html);
  return { pageFile, tmpDir };
}

async function openPage(browser, pageFile, view, defaults) {
  const page = await browser.newPage({
    viewport: view.viewport || defaults.viewport,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  // A control that opens a real URL or a dialog must not hang or navigate the
  // harness away from the page under test.
  page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
  await page.addInitScript(INSTALL_VISIBILITY_HELPER);
  await page.goto(require('url').pathToFileURL(pageFile).href, { waitUntil: 'load' });
  await page.waitForTimeout(view.settleMs || defaults.settleMs || 1200);
  return page;
}

/**
 * Waits until the DOM stops changing on its own.
 *
 * Without this, a click that triggers an async re-render bleeds into the *next*
 * control's measurement: that control looks like it changed the DOM when it did
 * nothing at all, and a genuinely dead button right after a live one is scored
 * as wired. Two identical consecutive reads mean the previous click has landed.
 */
async function waitForQuietDom(page, { pollMs = 100, maxWaitMs = 3000 } = {}) {
  let previous = await page.evaluate(DOM_SIGNATURE);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    const current = await page.evaluate(DOM_SIGNATURE);
    if (current === previous) {
      return true;
    }
    previous = current;
  }
  return false;
}

async function clickControl(page, control) {
  // Settle first, so what we measure is this click's doing and not the last one's.
  const quiet = await waitForQuietDom(page);
  const before = await page.evaluate(DOM_SIGNATURE);
  await page.evaluate(() => {
    window.__HARNESS_POSTED_MESSAGES__.length = 0;
    window.__HARNESS_ERRORS__.length = 0;
  });

  const locator = page.locator(`[data-smoke-id="${control.index}"]`);
  try {
    if (control.tag === 'select') {
      // selectOption fires input+change the way a user picking an option does;
      // a plain click only opens the native picker, which the page never sees.
      await locator.selectOption(control.selectValue, { timeout: 1500 });
    } else {
      await locator.click({ timeout: 1500, force: false, noWaitAfter: true });
    }
  } catch (error) {
    return { status: 'skipped', reason: `not ${control.tag === 'select' ? 'selectable' : 'clickable'} in this pass: ${String(error.message).split('\n')[0]}` };
  }

  // A select change usually triggers a full re-render; give it the same settle
  // window a click gets before reading the signature back.
  await page.waitForTimeout(control.tag === 'select' ? 250 : 120);

  const [posted, errors, after] = await Promise.all([
    page.evaluate(() => window.__HARNESS_POSTED_MESSAGES__.slice()),
    page.evaluate(() => window.__HARNESS_ERRORS__.slice()),
    page.evaluate(DOM_SIGNATURE),
  ]);

  if (errors.length > 0) {
    return { status: 'error', posted, errors, quiet };
  }
  if (posted.length > 0) {
    return { status: 'posted', posted, domChanged: before !== after, quiet };
  }
  if (before !== after) {
    return { status: 'dom-only', posted, domChanged: true, quiet };
  }
  return { status: 'dead', posted, domChanged: false, quiet };
}

/** Replays one declared scenario on a fresh page and reports what each step did. */
async function runScenario(page, view, scenario) {
  const steps = [];
  const findings = [];
  const fail = (control, detail) => findings.push({ view: view.id, kind: 'scenario-step-failed', control, detail });

  for (const step of scenario.steps) {
    const label = `${scenario.name}: ${describeStep(step)}`;
    // A select with nothing else to offer changes nothing, but the step still
    // has to clear the shared checks below — a broken single-option state is
    // exactly what `expect` is there to catch.
    let noop = false;
    await waitForQuietDom(page);
    const before = await page.evaluate(DOM_SIGNATURE);
    await page.evaluate(() => {
      window.__HARNESS_POSTED_MESSAGES__.length = 0;
      window.__HARNESS_ERRORS__.length = 0;
    });

    if (step.click || step.post || step.type || step.press) {
      const reason = await applyStep(page, step);
      if (reason) {
        fail(label, reason);
        break;
      }
    } else {
      const pick = await page.evaluate(PICK_OPTION, [step.select, step.value ?? null]);
      if (pick.missing) {
        fail(label, 'the scenario expects this control to be on screen, and it is not');
        break;
      }
      if (pick.unavailable) {
        fail(label, `option '${step.value}' is not offered by ${step.select}`);
        break;
      }
      if (pick.noop) {
        noop = true;
      } else {
        try {
          await page.selectOption(step.select, pick.value, { timeout: 2000 });
        } catch (error) {
          fail(label, `could not change: ${String(error.message).split('\n')[0]}`);
          break;
        }
      }
    }

    await page.waitForTimeout(120);
    await waitForQuietDom(page);
    const [errors, after] = await Promise.all([
      page.evaluate(() => window.__HARNESS_ERRORS__.slice()),
      page.evaluate(DOM_SIGNATURE),
    ]);
    if (errors.length > 0) {
      findings.push({ view: view.id, kind: 'scenario-step-threw', control: label, detail: errors.join(' | ').slice(0, 400) });
      break;
    }
    // `expect` is what the view must still be showing after the step — the point
    // of the scenario, not a bonus assertion: a picker that silently drops to an
    // empty state is exactly the failure worth catching.
    if (scenario.expect) {
      const showing = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return Boolean(el && window.__SMOKE_IS_VISIBLE__(el));
      }, scenario.expect);
      if (!showing) {
        findings.push({
          view: view.id,
          kind: 'scenario-expectation-failed',
          control: label,
          detail: `'${scenario.expect}' is not showing after this step`,
        });
        break;
      }
    }
    steps.push({ step: label, status: noop ? 'noop-single-option' : before === after ? 'no-dom-change' : 'ok' });
  }

  return { name: scenario.name, steps, findings };
}

async function smokeView({ browser, view, defaults, handledCommands, isolate }) {
  const bundlePath = path.join(DIST_DIR, `${view.bundle}.js`);
  if (!fs.existsSync(bundlePath)) {
    return {
      view: view.id,
      status: 'error',
      error: `Missing bundle ${path.relative(REPO_ROOT, bundlePath)} — run \`npm run compile\` in vscode-extension/ first.`,
      controls: [],
      findings: [],
    };
  }
  const fixturePath = path.join(SKILL_DIR, 'fixtures', view.fixture);
  if (!fs.existsSync(fixturePath)) {
    return { view: view.id, status: 'error', error: `Missing fixture ${view.fixture}`, controls: [], findings: [] };
  }

  const { pageFile, tmpDir } = preparePage(view, fixturePath, bundlePath);
  let page = await openPage(browser, pageFile, view, defaults);

  const renderErrors = await page.evaluate(() => window.__HARNESS_ERRORS__.slice());
  const controls = await page.evaluate(TAG_CONTROLS, INTERACTIVE_SELECTOR);

  const results = [];
  const findings = [];

  // Re-tag before each interaction rather than trusting the first enumeration.
  // A control that re-renders its view (a tab button, a filter `<select>`)
  // replaces every tagged node, and the stale `data-smoke-id`s then make every
  // later control report `skipped` — untested, while the run still exits 0.
  // Re-tagging keeps the pass honest without `--isolate`'s page reload.
  for (const original of controls) {
    if (isolate && results.length > 0) {
      await page.close();
      page = await openPage(browser, pageFile, view, defaults);
    }
    const current = await page.evaluate(TAG_CONTROLS, INTERACTIVE_SELECTOR);
    // Find *this* control again by identity. Matching by array position would
    // drift the moment an earlier interaction added or removed a control — e.g.
    // switching the Efficiency resolution to Daily removes the drill picker, so
    // every later control would shift up one and be exercised in place of the
    // one actually intended.
    const control = current.find((c) => c.key === original.key);
    if (!control) {
      results.push({ ...original, status: 'skipped', reason: 'no longer present after an earlier interaction' });
      continue;
    }

    const outcome = await clickControl(page, control);
    results.push({ ...control, ...outcome });

    const where = `${control.tag}${control.id ? `#${control.id}` : ''}${control.label ? ` "${control.label}"` : ''}`;

    if (outcome.status === 'dead' && outcome.quiet === false) {
      // The DOM never stopped moving, so "nothing changed" is not trustworthy here.
      results[results.length - 1].status = 'inconclusive';
    } else if (outcome.status === 'dead' && control.alreadySelected) {
      results[results.length - 1].status = 'noop-selected';
    } else if (outcome.status === 'dead') {
      findings.push({
        view: view.id,
        kind: 'dead-control',
        control: where,
        detail: control.tag === 'select'
          ? 'changing its value posts no message to the host and changes nothing on screen'
          : 'clicking it posts no message to the host and changes nothing on screen',
      });
    }
    if (outcome.status === 'error') {
      findings.push({
        view: view.id,
        kind: control.tag === 'select' ? 'change-threw' : 'click-threw',
        control: where,
        detail: outcome.errors.join(' | ').slice(0, 400),
      });
    }
    for (const message of outcome.posted || []) {
      const command = message && (message.command || message.type);
      if (typeof command === 'string' && !handledCommands.has(command)) {
        findings.push({
          view: view.id,
          kind: 'unhandled-command',
          control: where,
          detail: `posts '${command}', which no handler on the extension side matches`,
        });
      }
    }
  }

  await page.close();

  // Scenarios get their own page each, so a scripted flow never inherits the
  // state the click pass left behind.
  const scenarios = [];
  for (const scenario of view.scenarios || []) {
    const scenarioPage = await openPage(browser, pageFile, view, defaults);
    const outcome = await runScenario(scenarioPage, view, scenario);
    await scenarioPage.close();
    scenarios.push({ name: outcome.name, steps: outcome.steps });
    findings.push(...outcome.findings);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  return {
    view: view.id,
    status: 'ok',
    renderErrors,
    controls: results,
    scenarios,
    findings,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig(SKILL_DIR);
  const views = selectViews(config, args.view);

  if (views.length === 0) {
    console.error(`❌ No views selected${args.view ? ` for --view ${args.view}` : ''}.`);
    process.exit(2);
  }

  const handledCommands = loadHandledCommands();
  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: true });

  // Views run side by side, each on its own pages; the clicks and scenarios
  // *within* a view stay sequential because they share that view's page.
  let reports;
  try {
    reports = await runPool(views, parseConcurrency(args.concurrency), (view) =>
      smokeView({
        browser,
        view,
        defaults: config.defaults,
        handledCommands,
        isolate: Boolean(args.isolate),
      })
    );
  } finally {
    await browser.close();
  }

  const findings = reports.flatMap((r) => r.findings);
  const errored = reports.filter((r) => r.status === 'error');

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify({ reports }, null, 2));
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: findings.length === 0 && errored.length === 0, reports }, null, 2));
    process.exit(findings.length === 0 && errored.length === 0 ? 0 : 1);
  }

  console.log('🖱️  Webview interaction smoke\n');

  for (const report of reports) {
    if (report.status === 'error') {
      console.error(`   ${report.view.padEnd(22)} ❌ ${report.error}`);
      continue;
    }
    const counts = report.controls.reduce((acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    const mark = report.findings.length === 0 ? '✅' : '❌';
    console.log(`   ${report.view.padEnd(22)} ${mark} ${report.controls.length} control(s): ${summary || 'none found'}`);
    for (const scenario of report.scenarios || []) {
      console.log(`   ${' '.repeat(22)}    ▸ ${scenario.name}: ${scenario.steps.length} step(s) replayed`);
    }
    if (report.renderErrors && report.renderErrors.length > 0) {
      console.log(`   ${' '.repeat(22)}    ⚠️  render error: ${report.renderErrors[0].split('\n')[0]}`);
    }
  }

  if (findings.length > 0) {
    console.error(`\n❌ ${findings.length} interaction finding(s):\n`);
    for (const finding of findings) {
      console.error(`   [${finding.view}] ${finding.kind}: ${finding.control}`);
      console.error(`      ${finding.detail}`);
    }
    console.error('');
  }

  if (errored.length > 0 || findings.length > 0) {
    console.error('❌ Interaction smoke failed!\n');
    process.exit(1);
  }

  console.log('\n✅ Every control does something when clicked or changed.\n');
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ ${error && error.message ? error.message : error}`);
    process.exit(2);
  });
}
