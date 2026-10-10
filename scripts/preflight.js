#!/usr/bin/env node
'use strict';

/**
 * Release preflight — one command that runs every check we have, in order,
 * against this machine's real editor data.
 *
 * The checks below mostly already existed; what did not exist was a way to run
 * them all and get a single verdict. They were spread across npm scripts, agent
 * skills and CI steps, so "is this safe to release?" meant remembering nine
 * commands and reading nine outputs. After a burst of merged PRs that is
 * exactly the moment nobody does it.
 *
 * Two things make this different from CI:
 *
 *   1. It runs on YOUR machine, so the local-data stage validates the real
 *      session logs from every editor you actually use. CI has no Copilot
 *      history, no ~/.copilot/data.db and no JetBrains logs, so it can never
 *      catch schema drift in a format you personally depend on.
 *   2. It never stops at the first failure. A release decision needs the whole
 *      picture, not the first thing that broke.
 *
 * A check that reports "not available on this machine" is listed separately
 * rather than counted as a pass — on a release machine those are the ones worth
 * looking at, because a green run that checked nothing is the failure mode this
 * whole thing exists to avoid.
 *
 * Usage:
 *   node scripts/preflight.js                 # everything
 *   node scripts/preflight.js --list          # show the checks, run nothing
 *   node scripts/preflight.js --stage ui      # one stage
 *   node scripts/preflight.js --skip visual   # all but one check
 *   node scripts/preflight.js --quick         # skip the slow UI stage
 *   node scripts/preflight.js --json          # machine-readable result
 *
 * Exit codes: 0 = release-ready, 1 = a required check failed, 2 = preflight
 * could not run.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(REPO_ROOT, 'vscode-extension');
const SKILLS = path.join(REPO_ROOT, '.github', 'skills');

const NODE = process.execPath;

/**
 * A check that is `optional` reports its result but never fails the run —
 * either because it is advisory (new fields observed in a log format) or
 * because it depends on data or network this machine may not have.
 */
const CHECKS = [
  // ---- stage: static -------------------------------------------------------
  {
    id: 'types',
    stage: 'static',
    title: 'TypeScript type check',
    cwd: EXT_DIR,
    command: ['npm', 'run', 'check-types'],
  },
  {
    id: 'lint',
    stage: 'static',
    title: 'ESLint',
    cwd: EXT_DIR,
    command: ['npm', 'run', 'lint'],
  },
  {
    id: 'json',
    stage: 'static',
    title: 'JSON data files',
    cwd: EXT_DIR,
    command: ['npm', 'run', 'lint:json'],
  },
  {
    id: 'l10n',
    stage: 'static',
    title: 'Localization keys',
    cwd: EXT_DIR,
    command: ['npm', 'run', 'lint:l10n'],
  },
  {
    id: 'compile',
    stage: 'static',
    title: 'Compile extension + webview bundles',
    cwd: EXT_DIR,
    command: ['npm', 'run', 'compile'],
    // Everything in the ui stage renders these bundles.
    required_by: ['interaction', 'visual'],
  },
  {
    id: 'contract',
    stage: 'static',
    title: 'Webview message contract',
    cwd: REPO_ROOT,
    command: [NODE, path.join('scripts', 'validate-webview-contract.js')],
    why: 'a button posting a command nobody handles compiles fine and does nothing',
  },

  // ---- stage: test ---------------------------------------------------------
  {
    id: 'unit',
    stage: 'test',
    title: 'Unit tests',
    cwd: EXT_DIR,
    command: ['npm', 'run', 'test:node'],
  },

  // ---- stage: ui -----------------------------------------------------------
  {
    id: 'interaction',
    stage: 'ui',
    title: 'Webview interaction smoke (clicks every control)',
    cwd: REPO_ROOT,
    command: [NODE, path.join('scripts', 'interaction-smoke.js')],
    why: 'a control with no listener looks identical to a working one until you click it',
    slow: true,
  },
  {
    id: 'visual',
    stage: 'ui',
    title: 'Visual view diff vs origin/main',
    cwd: REPO_ROOT,
    command: [NODE, path.join('.github', 'skills', 'visual-view-diff', 'visual-diff.js')],
    why: 'shows what the release actually looks like next to the last one',
    // A visual change is usually intended. This reports; a human reads it.
    optional: true,
    slow: true,
  },

  // ---- stage: local (real data on this machine) ----------------------------
  {
    id: 'editor-data',
    stage: 'local',
    title: 'Editor data coverage (which editors have readable sessions)',
    cwd: REPO_ROOT,
    command: [NODE, path.join('scripts', 'check-editor-data-coverage.js')],
    why: 'the schema check passes vacuously when it finds no data at all',
  },
  {
    id: 'session-schemas',
    stage: 'local',
    title: 'Session log schemas (your real editor logs)',
    cwd: REPO_ROOT,
    command: [NODE, path.join(SKILLS, 'validate-session-schemas', 'validate-session-schemas.js')],
    why: 'an editor update that changes its log format silently zeroes out your token counts',
  },
  {
    id: 'editor-names',
    stage: 'local',
    title: 'Editor name mapping (CLI vs extension)',
    cwd: REPO_ROOT,
    command: [NODE, path.join(SKILLS, 'validate-editor-names', 'validate-editor-names.js')],
  },
  {
    id: 'app-db',
    stage: 'local',
    title: 'Copilot app database schema',
    cwd: REPO_ROOT,
    command: [NODE, path.join(SKILLS, 'validate-app-db-schema', 'validate-schema.js')],
    // The script exits 1 both for "the schema drifted" and for "there is no
    // data.db here". Only the first is a release problem, and the message is
    // the only thing that tells them apart.
    unavailableWhen: /data\.db exists[\s\S]{0,80}Not found at/,
  },
  {
    id: 'model-pricing',
    stage: 'local',
    title: 'Model pricing coverage for locally-seen models',
    cwd: REPO_ROOT,
    command: [NODE, path.join(SKILLS, 'validate-model-pricing', 'validate-model-pricing.js')],
    // A model with no pricing entry is news, not a release blocker.
    optional: true,
  },
];

const STAGES = ['static', 'test', 'ui', 'local'];

const USAGE = `
Release preflight — runs every check we have and prints one verdict.

  node scripts/preflight.js                 everything
  node scripts/preflight.js --list          show the checks, run nothing
  node scripts/preflight.js --stage <name>  one stage: ${STAGES.join(', ')}
  node scripts/preflight.js --skip a,b      skip checks or whole stages by id
  node scripts/preflight.js --quick         skip the slow UI stage
  node scripts/preflight.js --json          machine-readable result

Exit codes: 0 release-ready | 1 a required check failed | 2 could not run.
`.trim();

const STAGE_BLURBS = {
  static: 'compiles, lints, and the wiring the compiler cannot see',
  test: 'the unit suite',
  ui: 'what the panels actually do when you click them',
  local: 'your real editor data on this machine',
};

function parseArgs(argv) {
  const args = { skip: [], stage: null, list: false, json: false, quick: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--list') {
      args.list = true;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--quick') {
      args.quick = true;
    } else if (token === '--stage') {
      args.stage = argv[++i];
    } else if (token === '--skip') {
      args.skip.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    }
  }
  return args;
}

function selectChecks(args) {
  let checks = CHECKS;
  if (args.stage) {
    if (!STAGES.includes(args.stage)) {
      console.error(`❌ Unknown stage '${args.stage}'. Known stages: ${STAGES.join(', ')}`);
      process.exit(2);
    }
    checks = checks.filter((c) => c.stage === args.stage);
  }
  if (args.quick) {
    checks = checks.filter((c) => !c.slow);
  }
  if (args.skip.length > 0) {
    checks = checks.filter((c) => !args.skip.includes(c.id) && !args.skip.includes(c.stage));
  }
  return checks;
}

function runCheck(check) {
  const started = Date.now();
  const [command, ...commandArgs] = check.command;
  // npm is a shim on Windows (npm.cmd) and Node refuses to spawn .cmd files
  // without a shell, so npm scripts go through a shell there; direct node
  // invocations never need one.
  const isNpm = command === 'npm';
  const useShell = isNpm && process.platform === 'win32';
  const result = spawnSync(command, commandArgs, {
    cwd: check.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: useShell,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });

  const durationMs = Date.now() - started;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (result.error) {
    return { ...check, status: 'error', durationMs, stdout, stderr, detail: result.error.message };
  }

  // The repo's validate-* scripts share a convention: 2 means "could not run
  // here" (no data, no sqlite, no network), which on a developer machine is
  // information, not a failed release gate.
  if (result.status === 2) {
    return { ...check, status: 'unavailable', durationMs, stdout, stderr };
  }

  // A few checks fold "nothing to check here" into their ordinary failure exit
  // code, so the only way to tell a real regression from a missing prerequisite
  // is what they printed.
  if (result.status !== 0 && check.unavailableWhen && check.unavailableWhen.test(`${stdout}${stderr}`)) {
    return { ...check, status: 'unavailable', durationMs, stdout, stderr };
  }

  return {
    ...check,
    status: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status,
    durationMs,
    stdout,
    stderr,
  };
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const MARKS = { pass: '✅', fail: '❌', unavailable: '⏭️ ', error: '💥', skipped: '⏭️ ' };

function printList() {
  console.log('\n🚦 Release preflight checks\n');
  for (const stage of STAGES) {
    const inStage = CHECKS.filter((c) => c.stage === stage);
    if (inStage.length === 0) {
      continue;
    }
    console.log(`  ${stage} — ${STAGE_BLURBS[stage]}`);
    for (const check of inStage) {
      const tags = [check.optional ? 'optional' : null, check.slow ? 'slow' : null].filter(Boolean);
      console.log(`    ${check.id.padEnd(18)} ${check.title}${tags.length ? `  (${tags.join(', ')})` : ''}`);
      if (check.why) {
        console.log(`    ${' '.repeat(18)} ↳ ${check.why}`);
      }
    }
    console.log('');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (args.list) {
    printList();
    process.exit(0);
  }

  const checks = selectChecks(args);
  if (checks.length === 0) {
    console.error('❌ Every check was filtered out — nothing to run.');
    process.exit(2);
  }

  console.log('\n🚦 Release preflight\n');
  console.log(`   ${checks.length} check(s) on ${process.platform}, node ${process.version}\n`);

  const results = [];
  const failedIds = new Set();

  for (const check of checks) {
    // Skip a check whose prerequisite already failed: its output would be noise
    // about a missing bundle rather than about the thing it actually tests.
    const blockedBy = CHECKS.filter((c) => (c.required_by || []).includes(check.id) && failedIds.has(c.id));
    if (blockedBy.length > 0) {
      results.push({
        ...check,
        status: 'skipped',
        durationMs: 0,
        detail: `skipped — ${blockedBy.map((c) => c.id).join(', ')} failed first`,
      });
      console.log(`   ${MARKS.skipped} ${check.title} — skipped (${blockedBy.map((c) => c.id).join(', ')} failed)`);
      continue;
    }

    process.stdout.write(`   ⏳ ${check.title} …`);
    const result = runCheck(check);
    results.push(result);
    if (result.status === 'fail' || result.status === 'error') {
      failedIds.add(check.id);
    }

    const note = result.status === 'unavailable' ? ' (not available on this machine)' : '';
    process.stdout.write(`\r   ${MARKS[result.status]} ${check.title} — ${formatDuration(result.durationMs)}${note}\n`);
  }

  const blocking = results.filter((r) => (r.status === 'fail' || r.status === 'error') && !r.optional);
  const advisory = results.filter((r) => (r.status === 'fail' || r.status === 'error') && r.optional);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: blocking.length === 0,
          results: results.map(({ stdout, stderr, ...rest }) => ({
            ...rest,
            output: `${stdout}${stderr}`.trim().slice(-4000),
          })),
        },
        null,
        2
      )
    );
    process.exit(blocking.length === 0 ? 0 : 1);
  }

  for (const result of [...blocking, ...advisory]) {
    const label = result.optional ? 'ADVISORY' : 'BLOCKING';
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`${MARKS[result.status]} ${label}: ${result.title}`);
    if (result.why) {
      console.log(`   why it matters: ${result.why}`);
    }
    console.log(`${'─'.repeat(72)}`);
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    console.log(output ? output.split('\n').slice(-40).join('\n') : result.detail || '(no output)');
  }

  const unavailable = results.filter((r) => r.status === 'unavailable');
  if (unavailable.length > 0) {
    console.log(`\n⏭️  Not available on this machine: ${unavailable.map((r) => r.id).join(', ')}`);
    console.log('   These are the checks that need real local editor data — on a release');
    console.log('   machine they should run, so this is worth a look before you tag.');
  }

  console.log('');
  if (blocking.length > 0) {
    console.log(`❌ Not release-ready: ${blocking.length} blocking failure(s): ${blocking.map((r) => r.id).join(', ')}\n`);
    process.exit(1);
  }
  if (advisory.length > 0) {
    console.log(`⚠️  Release-ready, with ${advisory.length} advisory finding(s): ${advisory.map((r) => r.id).join(', ')}\n`);
    process.exit(0);
  }
  console.log('✅ Release-ready — every check passed.\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { CHECKS, STAGES, selectChecks, parseArgs };
