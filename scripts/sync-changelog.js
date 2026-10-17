#!/usr/bin/env node

/**
 * Backfill CHANGELOG.md with GitHub release notes
 *
 * The per-project CHANGELOG.md files are the source of release notes: they are
 * written in the release-prep PR (scripts/release-changelog.js promote) and the
 * release workflows copy them into the GitHub release. This script only works in
 * the other direction for releases the changelog does not know about yet: it
 * adds a section for each GitHub release whose version has no "## [<version>]"
 * section, and never rewrites a section that already exists.
 *
 * Usage:
 *   node scripts/sync-changelog.js [--test]
 * 
 * Options:
 *   --test    Use hardcoded test data instead of fetching from GitHub
 * 
 * Requirements:
 *   - GitHub CLI (gh) installed and authenticated OR GITHUB_TOKEN environment variable
 *   - Paths resolve from the repository root, so any working directory works
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { parseSections, serializeSections, detectEol, terminateLast } = require('./release-changelog');

// Resolve every path from the repo root, not the working directory: the script is
// run from the root (workflow) and from vscode-extension/ (npm run sync-changelog).
const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'vscode-extension', 'package.json');

const TEST_MODE = process.argv.includes('--test');

// Test data matching the actual GitHub releases
const TEST_RELEASES = [
  {
    tagName: "v0.0.2",
    name: "Release 0.0.2",
    body: "\n- Automated VSIX build and release workflow",
    createdAt: "2025-09-28T12:31:58Z",
    isPrerelease: false
  },
  {
    tagName: "v0.0.1",
    name: "First draft",
    body: "First rough version, not complete of course! \r\n\r\n- Only tested on windows\r\n- Use at your own risk 😄\r\n- Screenshots in the README\r\n- VS Code v1.104 or higher\r\n\r\n**Full Changelog**: https://github.com/rajbos/ai-engineering-fluency/commits/v0.0.1",
    createdAt: "2025-09-26T21:55:29Z",
    isPrerelease: true
  }
];

// The only GitHub owner/repo this script is ever meant to talk to. Kept as
// hardcoded constants (not read from a file) so the values actually embedded
// in outbound GitHub API requests never carry file-derived data — see
// getGitHubOwnerRepo() below for why this matters.
const EXPECTED_OWNER = 'rajbos';
const EXPECTED_REPO = 'ai-engineering-fluency';

/**
 * Read package.json and confirm its `repository.url` field points at the
 * expected GitHub repo, then return the hardcoded EXPECTED_OWNER/EXPECTED_REPO
 * constants — not the strings extracted from package.json.
 *
 * This script only ever needs to call the GitHub API for this one repo, so
 * package.json is used purely as a sanity check, never as the source of the
 * values embedded in outbound requests (and the `gh api` command line).
 * Returning the file-derived strings directly would mean file content flows
 * into a network request/shell command; returning the hardcoded constants
 * instead — after validating they match — avoids that entirely, regardless of
 * what package.json happens to contain.
 */
function getGitHubOwnerRepo() {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const repoUrl = packageJson.repository?.url || '';
  const match = repoUrl.match(/github\.com[\/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error('Could not extract repository information from package.json');
  }
  const [, owner, repo] = match;
  if (owner !== EXPECTED_OWNER || repo !== EXPECTED_REPO) {
    throw new Error(
      `package.json repository (${owner}/${repo}) does not match the expected ${EXPECTED_OWNER}/${EXPECTED_REPO}; refusing to use it`
    );
  }
  return { owner: EXPECTED_OWNER, repo: EXPECTED_REPO };
}

async function fetchGitHubReleases() {
  if (TEST_MODE) {
    console.log('🧪 Using test data (--test mode)...');
    return TEST_RELEASES;
  }
  
  // Try GitHub CLI first (use `gh api` which supports the full release body field)
  try {
    execSync('gh --version', { stdio: 'ignore' });
    const { owner: ownerCli, repo: repoCli } = getGitHubOwnerRepo();
    console.log('📡 Fetching GitHub releases using GitHub CLI (gh api)...');
    const releasesJson = execSync(
      `gh api repos/${ownerCli}/${repoCli}/releases?per_page=50`,
      { encoding: 'utf8' }
    );
    const apiReleases = JSON.parse(releasesJson);
    return apiReleases.map(r => ({
      tagName:      r.tag_name,
      name:         r.name,
      body:         r.body,
      createdAt:    r.created_at,
      isPrerelease: r.prerelease,
    }));
  } catch (error) {
    console.log('⚠️ GitHub CLI not available or not authenticated, falling back to GitHub API...');
  }
  
  // Fall back to GitHub API
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('❌ Error: GitHub CLI is not available and GITHUB_TOKEN environment variable is not set');
    console.error('   Please either:');
    console.error('   1. Install and authenticate GitHub CLI: https://cli.github.com/');
    console.error('   2. Set GITHUB_TOKEN environment variable with a GitHub personal access token');
    console.error('   3. Use --test flag to test with sample data');
    throw new Error('No authentication method available');
  }
  
  // Extract repository info from package.json
  const { owner, repo } = getGitHubOwnerRepo();
  console.log(`📡 Fetching releases for ${owner}/${repo} using GitHub API...`);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: `/repos/${owner}/${repo}/releases?per_page=50`,
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'changelog-sync-script',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
          return;
        }
        
        const apiReleases = JSON.parse(data);
        // Convert API format to CLI format
        const releases = apiReleases.map(release => ({
          tagName: release.tag_name,
          name: release.name,
          body: release.body,
          createdAt: release.created_at,
          isPrerelease: release.prerelease
        }));
        
        resolve(releases);
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

async function syncReleaseNotes() {
  try {
    console.log('🔄 Syncing per-project CHANGELOG files with GitHub release notes...');
    
    const releases = await fetchGitHubReleases();
    
    console.log(`📋 Found ${releases.length} releases`);
    
    if (releases.length === 0) {
      console.log('ℹ️ No releases found. Nothing to sync.');
      return;
    }
    
    // Sort releases by creation date (newest first)
    releases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Route releases to per-project changelogs based on tag prefix.
    // Bare v* tags (legacy) are treated as VS Code extension releases.
    const routingMap = {
      'vscode': 'vscode-extension/CHANGELOG.md',
      'cli':    'cli/CHANGELOG.md',
      'vs':     'visualstudio-extension/CHANGELOG.md',
    };

    /** @type {Map<string, Array>} */
    const byChangelog = new Map();
    for (const release of releases) {
      const tag = release.tagName;
      let changelogPath;
      if (tag.startsWith('vscode/v')) {
        changelogPath = routingMap['vscode'];
      } else if (tag.startsWith('cli/v')) {
        changelogPath = routingMap['cli'];
      } else if (tag.startsWith('vs/v')) {
        changelogPath = routingMap['vs'];
      } else if (/^v\d/.test(tag)) {
        // Legacy bare v* tags belong to the VS Code extension
        changelogPath = routingMap['vscode'];
      } else {
        // Other components (jetbrains/v*, ...) have no changelog here.
        console.log(`⏭️ Skipping ${tag}: no changelog for this component`);
        continue;
      }
      if (!byChangelog.has(changelogPath)) byChangelog.set(changelogPath, []);
      byChangelog.get(changelogPath).push(release);
    }

    for (const [changelogPath, changelogReleases] of byChangelog) {
      await writeChangelog(path.join(REPO_ROOT, changelogPath), changelogReleases);
    }

    console.log('✅ All per-project changelogs synced successfully!');
  } catch (error) {
    console.error('❌ Error syncing release notes:', error.message);
    process.exit(1);
  }
}

const DEFAULT_HEADER = `# Change Log\n\nAll notable changes to this project will be documented in this file.\n\nCheck [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.\n\n## [Unreleased]\n`;

/** Strip the tag prefix (vscode/v, cli/v, vs/v, plain v) to get the version. */
function versionFromTag(tagName) {
  return tagName.replace(/^(?:vscode|cli|vs)\/v/, '').replace(/^v/, '');
}

/** Turn a GitHub release body into changelog bullet lines. */
function formatReleaseBody(release, version) {
  const body = (release.body || '').replace(/\*\*Full Changelog\*\*:.*$/gm, '').trim();
  if (!body) {
    return [`- Release ${version}`];
  }
  return body.split('\n').map(line => {
    line = line.trim();
    if (line && !line.startsWith('-') && !line.startsWith('*') && !line.startsWith('#')) {
      return `- ${line}`;
    }
    return line;
  }).filter(line => line.length > 0);
}

/** Compare two "x.y.z" versions numerically; null when either does not parse. */
function compareVersions(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) { return null; }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) { return diff; }
  }
  return 0;
}

/**
 * Add a section for each release whose version is not in the changelog yet.
 * Existing sections — including the curated ones written by
 * release-changelog.js promote — are kept byte-for-byte, each line with its
 * own line ending, so even a mixed CRLF/LF file only gains the new lines. New
 * lines use the file's majority ending. A new section goes before the first
 * existing section with a lower version, or at the end.
 * @param {string} text     - current changelog ('' when the file is new)
 * @param {Array}  releases - GitHub releases
 * @returns {{ text: string, added: string[] }}
 */
function mergeReleases(text, releases) {
  const source = text || DEFAULT_HEADER;
  const { preamble, sections } = parseSections(source);
  const eol = detectEol(source);
  const added = [];
  for (const release of releases) {
    const version = versionFromTag(release.tagName);
    if (sections.some(s => s.name === version)) { continue; }
    const releaseType = release.isPrerelease ? ' - Pre-release' : '';
    const section = {
      name: version,
      heading: `## [${version}]${releaseType}${eol}`,
      body: [eol, ...formatReleaseBody(release, version).map(line => line + eol)],
    };
    const before = sections.findIndex(s => {
      const cmp = compareVersions(s.name, version);
      return cmp !== null && cmp < 0;
    });
    if (before >= 0) {
      section.body.push(eol); // blank line before the section that follows
      sections.splice(before, 0, section);
    } else {
      appendBlankLineAfter(sections.length > 0 ? sections[sections.length - 1] : null, preamble, eol);
      sections.push(section);
    }
    added.push(version);
  }
  if (added.length === 0) {
    return { text, added };
  }
  return { text: serializeSections(preamble, sections), added };
}

/**
 * Before appending a section at the end of the file, terminate the file's
 * last line if it was unterminated and add a blank line unless there is one.
 */
function appendBlankLineAfter(lastSection, preamble, eol) {
  if (lastSection && lastSection.body.length === 0) {
    if (!lastSection.heading.endsWith('\n')) { lastSection.heading += eol; }
    lastSection.body.push(eol);
    return;
  }
  const lines = lastSection ? lastSection.body : preamble;
  terminateLast(lines, eol);
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
    lines.push(eol);
  }
}

/**
 * Add the missing releases to a single changelog file.
 * @param {string} changelogPath - relative file path
 * @param {Array}  releases      - already sorted (newest first)
 */
async function writeChangelog(changelogPath, releases) {
  console.log(`\n📝 Updating ${changelogPath} (${releases.length} releases)...`);

  // Ensure the directory exists (idempotent — no need to check first, which
  // would leave a check-then-create race window).
  const dir = path.dirname(changelogPath);
  fs.mkdirSync(dir, { recursive: true });

  // Read current file (or start fresh). Attempt the read directly instead of
  // checking existence first, avoiding a TOCTOU race between the check and
  // the read.
  let changelog = '';
  try {
    changelog = fs.readFileSync(changelogPath, 'utf8');
    console.log(`📖 Reading existing ${changelogPath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') { throw err; }
    console.log(`📝 ${changelogPath} does not exist, creating new file`);
  }
  
  const { text: newChangelog, added } = mergeReleases(changelog, releases);
  if (added.length === 0) {
    console.log(`ℹ️ No changes needed — every release already has a section in ${changelogPath}`);
    return;
  }

  fs.writeFileSync(changelogPath, newChangelog);
  console.log(`💾 Added ${added.join(', ')} to ${changelogPath}`);
  
  try {
    const diff = execSync(`git diff "${changelogPath}"`, { encoding: 'utf8', cwd: REPO_ROOT });
    if (diff.trim()) {
      console.log(`📊 Changes made to ${changelogPath}:`);
      console.log(diff);
    } else {
      console.log(`ℹ️ No changes needed — ${changelogPath} is already up to date`);
    }
  } catch {
    console.log('💡 Could not show diff, but file was updated');
  }
}

// Run the sync if this script is executed directly
if (require.main === module) {
  syncReleaseNotes();
}

module.exports = { syncReleaseNotes, mergeReleases, versionFromTag, compareVersions };
