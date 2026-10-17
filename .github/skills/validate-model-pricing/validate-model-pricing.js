#!/usr/bin/env node
/**
 * validate-model-pricing.js
 *
 * Discovers recent AI-coding session log files and Copilot Chat debug logs on
 * the local machine, extracts every model ID that was actually used, then
 * cross-references the collected IDs against the keys in
 * src/modelPricing.json.
 *
 * Two result buckets:
 *   UNKNOWN       — model found in a log file, but NO key in modelPricing.json.
 *                   Cost estimation falls back to gpt-4o-mini pricing for these.
 *                   Reported as informational; does NOT cause a non-zero exit.
 *   UNUSED LOCALLY — key in modelPricing.json that matched no log file model ID.
 *                   Not an error; may be used on other machines / by teammates.
 *
 * File discovery mirrors validate-session-schemas.js (same platforms, same paths).
 * Debug logs (workspaceStorage/{hash}/GitHub.copilot-chat/debug-logs/{uuid}/main.jsonl)
 * are also scanned — they contain llm_request events with attrs.model, the most
 * authoritative source for VS Code chat session model attribution.
 *
 * Exit codes:  0 = completed (unknown models are informational, not errors)
 *              2 = configuration / environment error
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, days: 30, max: 20, verbose: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json':    opts.json    = true; break;
      case '--verbose': opts.verbose = true; break;
      case '-h': case '--help': opts.help = true; break;
      case '--days': opts.days = parseInt(argv[++i], 10); break;
      case '--max':  opts.max  = parseInt(argv[++i], 10); break;
      default:
        if (a.startsWith('--days=')) { opts.days = parseInt(a.split('=')[1], 10); }
        else if (a.startsWith('--max=')) { opts.max = parseInt(a.split('=')[1], 10); }
        else { throw new Error(`Unknown argument: ${a}`); }
    }
  }
  if (Number.isNaN(opts.days) || opts.days < 0) { throw new Error('--days must be a non-negative integer (0 = no limit)'); }
  if (Number.isNaN(opts.max)  || opts.max  < 1) { throw new Error('--max must be a positive integer'); }
  return opts;
}

function printHelp() {
  console.log(`validate-model-pricing — compare model IDs in local log files with modelPricing.json

Usage:
  node validate-model-pricing.js [options]

Options:
  --days N     Only consider files modified within the last N days (default 30; 0 = no limit)
  --max N      Analyze at most N most-recent files per platform (default 20)
  --verbose    Also list models that matched a pricing entry
  --json       Emit machine-readable JSON only
  -h, --help   Show this help

Exit codes: 0 ok | 2 config error`);
}

// ---------------------------------------------------------------------------
// Filesystem helpers (mirrors validate-session-schemas.js)
// ---------------------------------------------------------------------------

const HOME = os.homedir();

function existsDir(p)      { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function safeReaddir(p)    { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }
function statOrNull(p)     { try { return fs.statSync(p); } catch { return null; } }
function safeRead(p)       { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/** Recursively collect file paths matching predicate(name) up to a depth limit. */
function walkFiles(dir, predicate, out, depth) {
  if (depth < 0 || !existsDir(dir)) { return; }
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkFiles(full, predicate, out, depth - 1); }
    else if (predicate(entry.name)) { out.push(full); }
  }
}

function xdgDataHome() {
  if (os.platform() === 'win32') { return path.join(HOME, '.local', 'share'); }
  return process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
}

// ---------------------------------------------------------------------------
// VS Code user-data path discovery (mirrors validate-session-schemas.js)
// ---------------------------------------------------------------------------

function getVSCodeUserPaths() {
  const platform  = os.platform();
  const home      = os.homedir();
  const variants  = ['Code', 'Code - Insiders', 'Code - Exploration', 'VSCodium', 'Cursor'];
  const paths     = [];
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const v of variants) { paths.push(path.join(appData, v, 'User')); }
  } else if (platform === 'darwin') {
    for (const v of variants) { paths.push(path.join(home, 'Library', 'Application Support', v, 'User')); }
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const v of variants) { paths.push(path.join(xdg, v, 'User')); }
  }
  paths.push(
    path.join(home, '.vscode-server',          'data', 'User'),
    path.join(home, '.vscode-server-insiders', 'data', 'User'),
    path.join(home, '.vscode-remote',          'data', 'User'),
  );
  return paths;
}

// ---------------------------------------------------------------------------
// Per-platform session file discovery (mirrors validate-session-schemas.js)
// ---------------------------------------------------------------------------

const isUuidSession = (n) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(json|jsonl)$/i.test(n);
const isSessionFile = (n) => n.endsWith('.json') || n.endsWith('.jsonl');

function discoverCopilotChat() {
  const files = [];
  for (const userPath of getVSCodeUserPaths()) {
    if (!existsDir(userPath)) { continue; }
    const wsStorage = path.join(userPath, 'workspaceStorage');
    for (const ws of safeReaddir(wsStorage)) {
      if (!ws.isDirectory()) { continue; }
      const chat = path.join(wsStorage, ws.name, 'chatSessions');
      for (const f of safeReaddir(chat)) {
        if (!f.isDirectory() && isSessionFile(f.name)) { files.push(path.join(chat, f.name)); }
      }
    }
    const legacy = path.join(userPath, 'globalStorage', 'emptyWindowChatSessions');
    for (const f of safeReaddir(legacy)) {
      if (!f.isDirectory() && isSessionFile(f.name)) { files.push(path.join(legacy, f.name)); }
    }
    const copilotChat = path.join(userPath, 'globalStorage', 'github.copilot-chat');
    walkFiles(copilotChat, isUuidSession, files, 4);
  }
  return files;
}

function discoverCopilotCli() {
  const root  = path.join(HOME, '.copilot', 'session-state');
  const files = [];
  walkFiles(root, isSessionFile, files, 2);
  return files;
}

function discoverJetBrains() {
  const root  = path.join(HOME, '.copilot', 'jb');
  const files = [];
  walkFiles(root, (n) => n.startsWith('partition-') && n.endsWith('.jsonl'), files, 2);
  return files;
}

function discoverClaudeCode() {
  const root  = path.join(HOME, '.claude', 'projects');
  const files = [];
  walkFiles(root, (n) => n.endsWith('.jsonl'), files, 3);
  return files;
}

function discoverGeminiCli() {
  const root  = path.join(HOME, '.gemini', 'tmp');
  const files = [];
  walkFiles(root, (n) => n.startsWith('session-') && n.endsWith('.jsonl'), files, 3);
  return files;
}

function discoverAntigravity() {
  const root  = path.join(HOME, '.gemini', 'antigravity', 'brain');
  const files = [];
  walkFiles(root, (n) => n === 'transcript.jsonl', files, 4);
  return files;
}

function discoverOpenCode() {
  const root  = path.join(xdgDataHome(), 'opencode', 'storage', 'session');
  const files = [];
  walkFiles(root, (n) => n.startsWith('ses_') && n.endsWith('.json'), files, 4);
  return files;
}

/**
 * Debug logs: workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/<uuid>/main.jsonl
 * These contain llm_request events with attrs.model — the most authoritative model source.
 */
function discoverDebugLogs() {
  const files = [];
  const extFolders = ['GitHub.copilot-chat', 'github.copilot-chat', 'GitHub.copilot', 'github.copilot'];
  for (const userPath of getVSCodeUserPaths()) {
    const wsStorage = path.join(userPath, 'workspaceStorage');
    for (const ws of safeReaddir(wsStorage)) {
      if (!ws.isDirectory()) { continue; }
      for (const extFolder of extFolders) {
        const debugRoot = path.join(wsStorage, ws.name, extFolder, 'debug-logs');
        for (const sessionDir of safeReaddir(debugRoot)) {
          if (!sessionDir.isDirectory()) { continue; }
          const main = path.join(debugRoot, sessionDir.name, 'main.jsonl');
          if (statOrNull(main)) { files.push(main); }
        }
      }
    }
  }
  return files;
}

const PLATFORMS = [
  { id: 'copilot-chat',  discover: discoverCopilotChat },
  { id: 'copilot-cli',   discover: discoverCopilotCli  },
  { id: 'jetbrains',     discover: discoverJetBrains    },
  { id: 'claude-code',   discover: discoverClaudeCode   },
  { id: 'gemini-cli',    discover: discoverGeminiCli    },
  { id: 'antigravity',   discover: discoverAntigravity  },
  { id: 'opencode',      discover: discoverOpenCode     },
  { id: 'debug-logs',    discover: discoverDebugLogs    },
];

// ---------------------------------------------------------------------------
// Recency filter & capping
// ---------------------------------------------------------------------------

function filterByRecency(files, days) {
  if (days === 0) { return files; }
  const cutoff = Date.now() - days * 86_400_000;
  return files.filter((f) => {
    const s = statOrNull(f);
    return s && s.mtimeMs >= cutoff;
  });
}

function newestFirst(files) {
  return files.slice().sort((a, b) => {
    const sa = statOrNull(a), sb = statOrNull(b);
    return (sb ? sb.mtimeMs : 0) - (sa ? sa.mtimeMs : 0);
  });
}

// ---------------------------------------------------------------------------
// Model ID extraction
// ---------------------------------------------------------------------------

/** Strip copilot/ prefix — mirrors getModelFromRequest() in tokenEstimation.ts */
function stripPrefix(id) {
  return typeof id === 'string' ? id.replace(/^copilot\//, '') : '';
}

/**
 * Very small set of tokens that appear as "model" strings in non-model contexts.
 * We skip these to avoid false positives (e.g. a "model" key in OpenCode session
 * metadata that contains a workspace or tool name).
 */
const SKIP_VALUES = new Set([
  '', 'unknown', 'null', 'undefined', 'gpt-4',   // gpt-4 is the hard-coded default in helpers
  'true', 'false',
]);

function isValidModelId(raw) {
  if (!raw || typeof raw !== 'string') { return false; }
  const s = raw.trim();
  if (SKIP_VALUES.has(s)) { return false; }
  // Must contain at least one letter and one digit or hyphen — model IDs like
  // "gpt-4o", "claude-sonnet-4.6", "mistral-medium-3.5" all pass.
  if (!/[a-z]/i.test(s)) { return false; }
  if (s.length > 120) { return false; }  // sanity guard against large blobs
  return true;
}

function addModel(set, raw) {
  const stripped = stripPrefix(raw);
  if (isValidModelId(stripped)) { set.add(stripped); }
}

/**
 * Recursively walk an arbitrary value and collect anything that looks like a
 * model ID at known field names: modelId, model, modelKey.
 */
function walkForModels(value, fieldName, set, depth) {
  if (depth < 0 || value === null || value === undefined) { return; }
  if (typeof value === 'string') {
    if (fieldName === 'modelId' || fieldName === 'model' || fieldName === 'modelKey') {
      addModel(set, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) { walkForModels(item, null, set, depth - 1); }
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { walkForModels(v, k, set, depth - 1); }
  }
}

/** Extract model IDs from a fully-parsed JSON session object (non-JSONL). */
function extractFromJsonSession(obj, set) {
  // Standard VS Code Chat JSON: requests[].result.metadata.modelId and requests[].modelId
  const requests = Array.isArray(obj?.requests) ? obj.requests : [];
  for (const req of requests) {
    if (req?.modelId)                         { addModel(set, req.modelId); }
    if (req?.result?.metadata?.modelId)       { addModel(set, req.result.metadata.modelId); }
    // Some older formats embed model in result.details as a display name — skip those here
    // (display-name resolution belongs in tokenEstimation.ts, not in a surface scan)
  }
  // OpenCode and other formats that store model at the top level
  walkForModels(obj, null, set, 6);
}

/** Extract model IDs from a single parsed JSONL line. */
function extractFromJsonlLine(rec, set) {
  if (!rec || typeof rec !== 'object') { return; }

  // Copilot CLI event format: type === "session.shutdown" → data.model
  if (rec.type === 'session.shutdown' && rec.data?.model) {
    addModel(set, rec.data.model);
  }
  // Debug log format: type === "llm_request" → attrs.model
  if (rec.type === 'llm_request' && rec.attrs?.model) {
    addModel(set, rec.attrs.model);
  }
  // Claude Code: role === "assistant" → model
  if (rec.role === 'assistant' && rec.model) {
    addModel(set, rec.model);
  }
  // Gemini CLI and others that store model directly on the record
  if (typeof rec.model === 'string') { addModel(set, rec.model); }

  // Delta-format JSONL (VS Code Chat, kind is an integer): state patches may
  // embed modelId values deep inside patch payloads. Walk recursively.
  if (typeof rec.kind === 'number') {
    walkForModels(rec, null, set, 8);
    return;  // don't double-walk below
  }

  // Generic walk for any remaining JSONL formats
  walkForModels(rec, null, set, 6);
}

/**
 * Extract all model IDs from a file's raw content.
 * Returns the set of unique model IDs found.
 */
function extractModelsFromContent(filePath, raw) {
  const set = new Set();
  if (!raw || !raw.trim()) { return set; }

  const isJsonl = filePath.endsWith('.jsonl');

  if (isJsonl) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) { continue; }
      try { extractFromJsonlLine(JSON.parse(line), set); } catch { /* skip malformed */ }
    }
    return set;
  }

  // .json file — try full parse first
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }

  if (parsed !== undefined) {
    extractFromJsonSession(parsed, set);
    return set;
  }

  // Fallback: file is .json but actually JSONL content (e.g. CLI writes .json events)
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) { continue; }
    try { extractFromJsonlLine(JSON.parse(line), set); } catch { /* skip */ }
  }
  return set;
}

// ---------------------------------------------------------------------------
// modelPricing.json loader
// ---------------------------------------------------------------------------

function loadModelPricing(repoRoot) {
  const p = path.join(repoRoot, 'src', 'modelPricing.json');
  const raw = safeRead(p);
  if (!raw) { throw new Error(`Cannot read modelPricing.json at ${p}`); }
  const parsed = JSON.parse(raw);
  // The JSON has a top-level "pricing" sub-key
  const pricing = parsed.pricing ?? parsed;
  if (typeof pricing !== 'object' || Array.isArray(pricing)) {
    throw new Error('modelPricing.json has unexpected structure — expected a "pricing" object');
  }
  return pricing;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function findRepoRoot() {
  // Walk up from __dirname until we find vscode-extension/
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsDir(path.join(dir, 'vscode-extension'))) { return dir; }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  throw new Error('Could not locate repository root (directory containing vscode-extension/)');
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv); }
  catch (e) { console.error(`Error: ${e.message}\nRun with --help for usage.`); process.exit(2); }

  if (opts.help) { printHelp(); return; }

  // Locate modelPricing.json
  let repoRoot, modelPricing;
  try {
    repoRoot     = findRepoRoot();
    modelPricing = loadModelPricing(repoRoot);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(2);
  }

  const knownKeys = new Set(Object.keys(modelPricing));

  if (!opts.json) {
    console.log(`\nValidating model pricing coverage`);
    console.log(`  modelPricing.json: ${knownKeys.size} entries`);
    console.log(`  Recency window:    ${opts.days === 0 ? 'unlimited' : `${opts.days} days`}`);
    console.log(`  Max files/platform: ${opts.max}`);
    console.log('');
  }

  // Collect models per platform
  const platformResults = [];
  const allFoundModels  = new Map(); // model id -> Set of platform ids

  for (const platform of PLATFORMS) {
    let discovered = platform.discover();
    discovered = filterByRecency(discovered, opts.days);
    discovered = newestFirst(discovered).slice(0, opts.max);

    const platformModels = new Set();
    let filesScanned = 0;

    for (const filePath of discovered) {
      const raw = safeRead(filePath);
      if (!raw) { continue; }
      const found = extractModelsFromContent(filePath, raw);
      for (const m of found) { platformModels.add(m); }
      filesScanned++;
    }

    for (const m of platformModels) {
      if (!allFoundModels.has(m)) { allFoundModels.set(m, new Set()); }
      allFoundModels.get(m).add(platform.id);
    }

    platformResults.push({
      platform: platform.id,
      filesDiscovered: platform.discover().length,
      filesInWindow:   filterByRecency(platform.discover(), opts.days).length,
      filesScanned,
      modelsFound: [...platformModels].sort(),
    });
  }

  // Classify models
  const unknownModels  = []; // in logs but NOT in pricing
  const matchedModels  = []; // in logs AND in pricing
  const unusedModels   = []; // in pricing but NOT in any log

  for (const [model, platforms] of [...allFoundModels.entries()].sort()) {
    if (knownKeys.has(model)) {
      matchedModels.push({ model, platforms: [...platforms].sort() });
    } else {
      unknownModels.push({ model, platforms: [...platforms].sort() });
    }
  }

  for (const key of [...knownKeys].sort()) {
    if (!allFoundModels.has(key)) { unusedModels.push(key); }
  }

  // Output
  if (opts.json) {
    const output = {
      summary: {
        knownPricingKeys: knownKeys.size,
        modelsFoundInLogs: allFoundModels.size,
        matched: matchedModels.length,
        unknown: unknownModels.length,
        unusedLocally: unusedModels.length,
      },
      unknown: unknownModels,
      unusedLocally: unusedModels,
      matched: matchedModels,
      platforms: platformResults,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Human-readable output
  if (unknownModels.length > 0) {
    console.log(`UNKNOWN models (found in logs, missing from modelPricing.json)`);
    console.log(`  These fall back to gpt-4o-mini pricing — consider adding them.\n`);
    for (const { model, platforms } of unknownModels) {
      console.log(`  ⚠  ${model}`);
      console.log(`     seen in: ${platforms.join(', ')}`);
    }
    console.log('');
  } else {
    console.log(`✓  No unknown models — all log-file model IDs have a pricing entry.\n`);
  }

  if (unusedModels.length > 0 && opts.verbose) {
    console.log(`UNUSED LOCALLY (in modelPricing.json but not seen in scanned logs)`);
    for (const key of unusedModels) { console.log(`     ${key}`); }
    console.log('');
  }

  if (opts.verbose && matchedModels.length > 0) {
    console.log(`MATCHED models (found in logs AND in modelPricing.json)`);
    for (const { model, platforms } of matchedModels) {
      console.log(`  ✓  ${model}  [${platforms.join(', ')}]`);
    }
    console.log('');
  }

  // Per-platform summary
  console.log('Per-platform scan summary:');
  const col = Math.max(...platformResults.map((r) => r.platform.length), 12);
  console.log(`  ${'Platform'.padEnd(col)}  Files (total / in window / scanned)  Models found`);
  console.log(`  ${''.padEnd(col, '-')}  -----------------------------------  ------------`);
  for (const r of platformResults) {
    const files = `${String(r.filesDiscovered).padStart(5)} / ${String(r.filesInWindow).padStart(5)} / ${String(r.filesScanned).padStart(5)}`;
    console.log(`  ${r.platform.padEnd(col)}  ${files}  ${r.modelsFound.length}`);
  }
  console.log('');

  // Final summary line
  const totalFiles = platformResults.reduce((s, r) => s + r.filesScanned, 0);
  console.log(`Summary: ${totalFiles} files scanned, ${allFoundModels.size} unique model IDs found`);
  console.log(`  ${matchedModels.length} matched pricing entries, ${unknownModels.length} unknown (no pricing entry), ${unusedModels.length} unused locally`);
  if (unknownModels.length > 0) {
    console.log(`\n  Tip: add entries for unknown models to src/modelPricing.json`);
    console.log(`       and re-run this skill to confirm coverage.`);
  }
}

main().catch((e) => { console.error(`Unexpected error: ${e.message}`); process.exit(2); });
