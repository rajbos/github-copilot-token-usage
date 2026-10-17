'use strict';
/*
 * Performance micro-benchmark for the hot, dependency-light token-math functions.
 *
 * It measures the *running* code of a given build of the extension: point it at a
 * compiled `vscode-extension` directory and it times the key functions over fixed,
 * deterministic inputs, writing median/min timings to a JSON file.
 *
 * The same script (from the PR checkout) is run against BOTH the base and the PR
 * builds so the comparison is apples-to-apples — the base checkout does not need
 * to contain this script. Compare the two outputs with
 * .github/workflows/scripts/perf_compare.py (see the performance-expert agent).
 *
 *   node scripts/benchmark/perf-bench.cjs <vscode-extension-dir> <out.json>
 *
 * `tokenEstimation.ts` imports only types and the pure `utils/dayKeys` helper, so
 * the compiled module loads without the VS Code API.
 */

const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const outPath = process.argv[3];
if (!dir || !outPath) {
  console.error('usage: perf-bench.cjs <vscode-extension-dir> <out.json>');
  process.exit(2);
}

// Deterministic PRNG (mulberry32) so the base and PR runs see identical inputs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'token', 'model', 'session', 'usage', 'copilot', 'estimate', 'context',
  'request', 'response', 'analysis', 'cache', 'parse', 'content', 'message',
  'assistant', 'function', 'thinking', 'reasoning', 'pricing', 'ecosystem',
];

function words(rng, n) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(WORDS[Math.floor(rng() * WORDS.length)]);
  return parts.join(' ');
}

function buildJsonlSession(lines) {
  const rng = mulberry32(12345);
  const out = [];
  for (let i = 0; i < lines; i++) {
    const r = rng();
    if (r < 0.4) {
      out.push(JSON.stringify({ type: 'user.message', data: { content: words(rng, 20 + Math.floor(rng() * 40)), turnId: `turn-${i}` } }));
    } else if (r < 0.85) {
      out.push(JSON.stringify({ type: 'assistant.message', data: { content: words(rng, 40 + Math.floor(rng() * 120)), turnId: `turn-${i}` } }));
    } else {
      out.push(JSON.stringify({ type: 'tool.execution_complete', data: { content: words(rng, 10 + Math.floor(rng() * 30)) } }));
    }
  }
  return out.join('\n');
}

function buildText(approxChars) {
  const rng = mulberry32(999);
  let s = '';
  while (s.length < approxChars) s += words(rng, 50) + '\n';
  return s;
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function bench(fn, warmup, iters) {
  if (typeof fn !== 'function') return null;
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  return { medianMs: +median(times).toFixed(4), minMs: +Math.min(...times).toFixed(4), iterations: iters };
}

let mod;
try {
  mod = require(path.resolve(dir, 'out/src/tokenEstimation.js'));
} catch (e) {
  // Don't fail the job — record the problem so the comparator can report
  // "could not measure" rather than a false regression.
  console.error('Could not load tokenEstimation module:', e.message);
  fs.writeFileSync(outPath, JSON.stringify({ node: process.version, error: String(e.message), benchmarks: {} }, null, 2));
  process.exit(0);
}

const jsonl = buildJsonlSession(2500);
const benchmarks = {};

// Per-session parse + token-count over ~2500 JSONL lines — the dominant cost when
// the extension processes a session file.
const b1 = bench(() => mod.estimateTokensFromJsonlSession && mod.estimateTokensFromJsonlSession(jsonl), 10, 51);
if (b1 && typeof mod.estimateTokensFromJsonlSession === 'function') {
  b1.inputBytes = Buffer.byteLength(jsonl);
  benchmarks.estimateTokensFromJsonlSession = b1;
}

// estimateTokensFromText is O(1) in the text length but is called for every message
// part / response item / tool result across all sessions on each refresh — so the
// realistic hot cost is high call frequency, not large input. We benchmark many small
// calls with a realistic multi-entry estimators map (a single call on a big string is
// too cheap to measure and would sit below the noise floor). A stable estimators object
// reference matches production, where entries are precomputed and cached per reference.
const ESTIMATORS = {
  'gpt-4': 4, 'gpt-4o': 3.8, 'gpt-3.5-turbo': 4, 'o1-preview': 3.9,
  'claude-3-5-sonnet': 3.5, 'claude-3-opus': 3.6, 'claude-3-haiku': 3.7,
  'gemini-1.5-pro': 3.8, 'gemini-1.5-flash': 3.9, 'llama-3.1': 4.1,
};
const MODELS = ['gpt-4o', 'claude-3-5-sonnet', 'gemini-1.5-flash', 'unknown-model', 'llama-3.1-70b'];
const PART_TEXT = buildText(200);
const TEXT_CALLS = 50000;
const b2 = bench(() => {
  if (!mod.estimateTokensFromText) return;
  for (let i = 0; i < TEXT_CALLS; i++) {
    mod.estimateTokensFromText(PART_TEXT, MODELS[i % MODELS.length], ESTIMATORS);
  }
}, 10, 31);
if (b2 && typeof mod.estimateTokensFromText === 'function') {
  b2.calls = TEXT_CALLS;
  benchmarks.estimateTokensFromText = b2;
}

fs.writeFileSync(outPath, JSON.stringify({ node: process.version, benchmarks }, null, 2));
console.error('Wrote', outPath, JSON.stringify(benchmarks));
