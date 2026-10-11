#!/usr/bin/env node
/**
 * validate-schema.js — Validate ~/.copilot/data.db schema for the session
 * hierarchy feature.
 *
 * Checks that workspace_parent_links, workspaces and sessions tables still
 * have the columns the extension depends on, then runs the actual JOIN query
 * against today's data to confirm end-to-end reads work.
 *
 * Usage:
 *   node .github/skills/validate-app-db-schema/validate-schema.js [--json] [--help]
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (or data.db not found)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const args     = process.argv.slice(2);
const jsonMode = args.includes('--json');
const helpMode = args.includes('--help');

if (helpMode) {
  console.log(`
validate-schema.js — Validate ~/.copilot/data.db schema for session hierarchy

USAGE:
  node validate-schema.js [--json] [--help]

OPTIONS:
  --json   Output results as JSON (default: human-readable)
  --help   Show this help

WHAT IT CHECKS:
  1. data.db file exists at ~/.copilot/data.db
  2. workspace_parent_links has: child_workspace_id, parent_workspace_id,
     creator_session_id, created_at
  3. workspaces has: id, session_id, name, updated_at
  4. sessions has: id, title, created_at, updated_at
  5. Live JOIN query runs without error and returns sensible results

EXIT CODES:
  0 — PASS (all checks succeeded)
  1 — FAIL (data.db missing, schema mismatch, or query failed)
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Required schema definition
// ---------------------------------------------------------------------------
const REQUIRED = {
  workspace_parent_links: ['child_workspace_id', 'parent_workspace_id', 'creator_session_id', 'created_at'],
  workspaces:             ['id', 'session_id', 'name', 'updated_at'],
  sessions:               ['id', 'title', 'created_at', 'updated_at'],
};

// ---------------------------------------------------------------------------
// sql.js bootstrap (pure WASM — no native sqlite3 needed)
// ---------------------------------------------------------------------------
async function loadSqlJs() {
  // Try to find sql.js in the vscode-extension node_modules first (already installed),
  // then fall back to a local install if present.
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'vscode-extension', 'node_modules', 'sql.js'),
    path.join(__dirname, 'node_modules', 'sql.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'dist', 'sql-wasm.js'))) {
      const initSqlJs = require(path.join(p, 'dist', 'sql-wasm.js'));
      const wasmPath  = path.join(p, 'dist', 'sql-wasm.wasm');
      const wasmBinary = fs.existsSync(wasmPath) ? fs.readFileSync(wasmPath) : undefined;
      return initSqlJs(wasmBinary ? { wasmBinary } : undefined);
    }
  }
  throw new Error(
    'sql.js not found. Run `pnpm add sql.js` inside vscode-extension/ or ' +
    path.join(__dirname, '') + ' first.'
  );
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------
async function validate() {
  const results = {
    dbPath:   path.join(os.homedir(), '.copilot', 'data.db'),
    checks:   [],
    passed:   0,
    failed:   0,
    liveQuery: null,
    timestamp: new Date().toISOString(),
  };

  function addCheck(name, passed, detail) {
    results.checks.push({ name, passed, detail: detail ?? '' });
    if (passed) { results.passed++; } else { results.failed++; }
  }

  // ── Check 1: file exists ──────────────────────────────────────────────────
  if (!fs.existsSync(results.dbPath)) {
    addCheck('data.db exists', false, `Not found at ${results.dbPath}`);
    return results;
  }
  addCheck('data.db exists', true, results.dbPath);

  // ── Load sql.js ───────────────────────────────────────────────────────────
  let SQL;
  try {
    SQL = await loadSqlJs();
  } catch (e) {
    addCheck('sql.js available', false, String(e));
    return results;
  }
  addCheck('sql.js available', true, '');

  // ── Open database ─────────────────────────────────────────────────────────
  let db;
  try {
    const buf = fs.readFileSync(results.dbPath);
    db = new SQL.Database(buf);
  } catch (e) {
    addCheck('open data.db', false, String(e));
    return results;
  }
  addCheck('open data.db', true, `size: ${fs.statSync(results.dbPath).size.toLocaleString()} bytes`);

  try {
    // ── Check 2-4: required table columns ───────────────────────────────────
    for (const [table, requiredCols] of Object.entries(REQUIRED)) {
      let existingCols;
      try {
        const info = db.exec(`PRAGMA table_info(${table})`);
        existingCols = info.length > 0
          ? info[0].values.map(r => r[1])   // column [1] is the name
          : [];
      } catch (e) {
        addCheck(`table: ${table}`, false, `PRAGMA failed: ${e}`);
        continue;
      }

      if (existingCols.length === 0) {
        addCheck(`table: ${table}`, false, 'Table does not exist');
        continue;
      }

      const missing = requiredCols.filter(c => !existingCols.includes(c));
      if (missing.length > 0) {
        addCheck(`table: ${table}`, false,
          `Missing columns: ${missing.join(', ')}. Present: ${existingCols.join(', ')}`);
      } else {
        addCheck(`table: ${table}`, true,
          `All ${requiredCols.length} required columns present`);
      }
    }

    // ── Check 5: live JOIN query (last 24 h) ─────────────────────────────────
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const liveQuery = `
      SELECT
        cw.session_id  AS child_uuid,
        cw.name        AS child_name,
        pw.session_id  AS parent_uuid,
        pw.name        AS parent_name,
        l.created_at
      FROM workspace_parent_links l
      JOIN workspaces cw ON cw.id = l.child_workspace_id
      JOIN workspaces pw ON pw.id = l.parent_workspace_id
      WHERE l.created_at >= '${since}'
      ORDER BY l.created_at DESC
      LIMIT 10
    `;

    try {
      const liveResult = db.exec(liveQuery);
      const rows = liveResult.length > 0 ? liveResult[0].values : [];
      results.liveQuery = {
        rowsReturned: rows.length,
        since,
        sampleRows: rows.slice(0, 3).map(r => ({
          childName:  r[1],
          parentName: r[3],
          createdAt:  r[4],
        })),
      };
      addCheck('live JOIN query', true,
        `${rows.length} parent/child link(s) in last 24h`);
    } catch (e) {
      addCheck('live JOIN query', false, String(e));
    }

    // ── Check 6: total link count (regression canary) ────────────────────────
    try {
      const countResult = db.exec('SELECT COUNT(*) FROM workspace_parent_links');
      const total = countResult.length > 0 ? countResult[0].values[0][0] : 0;
      addCheck('workspace_parent_links row count', true,
        `${total.toLocaleString()} total links in DB`);
    } catch (e) {
      addCheck('workspace_parent_links row count', false, String(e));
    }

  } finally {
    db.close();
  }

  return results;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
(async () => {
  let results;
  try {
    results = await validate();
  } catch (e) {
    const err = { error: String(e), passed: 0, failed: 1, timestamp: new Date().toISOString() };
    if (jsonMode) { console.log(JSON.stringify(err, null, 2)); }
    else { console.error('Unexpected error:', e); }
    process.exit(1);
  }

  const allPassed = results.failed === 0;

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const line = '─'.repeat(60);
    console.log(line);
    console.log('Copilot data.db schema validation');
    console.log(line);
    for (const c of results.checks) {
      const icon = c.passed ? '✅' : '❌';
      console.log(`${icon}  ${c.name}`);
      if (c.detail) { console.log(`     ${c.detail}`); }
    }
    console.log(line);
    if (results.liveQuery) {
      console.log(`Live query (last 24h): ${results.liveQuery.rowsReturned} link(s)`);
      for (const r of results.liveQuery.sampleRows) {
        console.log(`  ↑ ${r.parentName ?? '?'}  →  ${r.childName ?? '?'}  (${r.createdAt})`);
      }
      console.log(line);
    }
    console.log(`Result: ${allPassed ? '✅ PASS' : '❌ FAIL'} — ${results.passed} passed, ${results.failed} failed`);
    console.log(line);
  }

  process.exit(allPassed ? 0 : 1);
})();
