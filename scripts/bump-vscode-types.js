#!/usr/bin/env node
'use strict';

/**
 * Bump @types/vscode and engines.vscode together, but only to a version that
 * has been on npm for at least COOLDOWN_DAYS (default 42).
 *
 * Dependabot cannot do this itself: it allows one update entry per ecosystem +
 * directory and cannot set cooldown days per dependency, so @types/vscode is
 * ignored in .github/dependabot.yml and handled here instead. The two values
 * must move together because `vsce package` refuses to package when
 * engines.vscode is lower than @types/vscode.
 *
 * Usage:
 *   node scripts/bump-vscode-types.js [--dry-run]
 *
 * Writes vscode-extension/package.json (unless --dry-run) and prints
 * key=value lines (changed, from, to) on stdout for the calling workflow.
 * The lockfile is refreshed by the workflow afterwards (pnpm install --lockfile-only).
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || 42);
const PACKAGE_JSON = path.join(__dirname, '..', 'vscode-extension', 'package.json');
const REGISTRY_URL = 'https://registry.npmjs.org/@types%2Fvscode';
const DAY_MS = 24 * 60 * 60 * 1000;

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) { return pa[i] - pb[i]; }
  }
  return 0;
}

/**
 * Newest stable version published at least `cooldownDays` before `now`.
 * `time` is the registry's version -> ISO timestamp map. Pre-releases and
 * non-version keys ("created", "modified") are skipped.
 */
function pickEligibleVersion(time, now, cooldownDays) {
  const cutoff = now - cooldownDays * DAY_MS;
  let best = null;
  for (const [version, published] of Object.entries(time)) {
    if (!parseVersion(version)) { continue; }
    const publishedAt = Date.parse(published);
    if (Number.isNaN(publishedAt) || publishedAt > cutoff) { continue; }
    if (best === null || compareVersions(version, best) > 0) { best = version; }
  }
  return best;
}

/**
 * Returns the updated package.json text, or null when nothing should change.
 * Never downgrades. Edits the two values in place so formatting is preserved.
 */
function applyBump(packageJsonText, targetVersion) {
  const pkg = JSON.parse(packageJsonText);
  const current = pkg.devDependencies && pkg.devDependencies['@types/vscode'];
  if (!current || !parseVersion(current)) {
    throw new Error(`Expected @types/vscode to be pinned to an exact version, found: ${current}`);
  }
  if (compareVersions(targetVersion, current) <= 0) { return null; }

  const typesPattern = /("@types\/vscode":\s*")[^"]+(")/;
  const enginesPattern = /("engines":\s*\{\s*"vscode":\s*")[^"]+(")/;
  if (!typesPattern.test(packageJsonText) || !enginesPattern.test(packageJsonText)) {
    throw new Error('Could not locate @types/vscode or engines.vscode in package.json');
  }
  return packageJsonText
    .replace(typesPattern, `$1${targetVersion}$2`)
    .replace(enginesPattern, `$1^${targetVersion}$2`);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} returned ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const text = fs.readFileSync(PACKAGE_JSON, 'utf8');
  const current = JSON.parse(text).devDependencies['@types/vscode'];

  const packument = await fetchJson(REGISTRY_URL);
  const target = pickEligibleVersion(packument.time, Date.now(), COOLDOWN_DAYS);
  if (!target) {
    console.error(`No @types/vscode version is older than ${COOLDOWN_DAYS} days.`);
    console.log('changed=false');
    return;
  }

  const updated = applyBump(text, target);
  if (updated === null) {
    console.error(`@types/vscode ${current} is already the newest version past the ${COOLDOWN_DAYS}-day cooldown.`);
    console.log('changed=false');
    return;
  }

  if (!dryRun) { fs.writeFileSync(PACKAGE_JSON, updated); }
  console.error(`@types/vscode and engines.vscode: ${current} -> ${target}${dryRun ? ' (dry run)' : ''}`);
  console.log('changed=true');
  console.log(`from=${current}`);
  console.log(`to=${target}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { pickEligibleVersion, applyBump, compareVersions };
