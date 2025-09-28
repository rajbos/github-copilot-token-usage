#!/usr/bin/env node

/**
 * Sync CHANGELOG.md with GitHub release notes
 * 
 * This script fetches GitHub release notes and updates the local CHANGELOG.md file
 * to ensure consistency between local documentation and published releases.
 * 
 * Usage:
 *   node scripts/sync-changelog.js [--test]
 * 
 * Options:
 *   --test    Use hardcoded test data instead of fetching from GitHub
 * 
 * Requirements:
 *   - GitHub CLI (gh) installed and authenticated OR GITHUB_TOKEN environment variable
 *   - Run from the repository root directory
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

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
    body: "First rough version, not complete of course! \r\n\r\n- Only tested on windows\r\n- Use at your own risk 😄\r\n- Screenshots in the README\r\n- VS Code v1.104 or higher\r\n\r\n**Full Changelog**: https://github.com/rajbos/github-copilot-token-usage/commits/v0.0.1",
    createdAt: "2025-09-26T21:55:29Z",
    isPrerelease: true
  }
];

async function fetchGitHubReleases() {
  if (TEST_MODE) {
    console.log('🧪 Using test data (--test mode)...');
    return TEST_RELEASES;
  }
  
  // Try GitHub CLI first
  try {
    execSync('gh --version', { stdio: 'ignore' });
    console.log('📡 Fetching GitHub releases using GitHub CLI...');
    const releasesJson = execSync('gh release list --json tagName,name,body,createdAt,isPrerelease --limit 50', { encoding: 'utf8' });
    return JSON.parse(releasesJson);
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
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const repoUrl = packageJson.repository?.url || '';
  const match = repoUrl.match(/github\.com[\/:](.+?)\/(.+?)(?:\.git)?$/);
  if (!match) {
    throw new Error('Could not extract repository information from package.json');
  }
  
  const [, owner, repo] = match;
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
    console.log('🔄 Syncing CHANGELOG.md with GitHub release notes...');
    
    // Check if we're in the right directory
    if (!fs.existsSync('package.json')) {
      console.error('❌ Error: This script must be run from the repository root directory');
      process.exit(1);
    }
    
    const releases = await fetchGitHubReleases();
    
    console.log(`📋 Found ${releases.length} releases`);
    
    if (releases.length === 0) {
      console.log('ℹ️ No releases found. Nothing to sync.');
      return;
    }
    
    // Sort releases by creation date (newest first)
    releases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Read current CHANGELOG.md
    let changelog = '';
    const changelogPath = 'CHANGELOG.md';
    if (fs.existsSync(changelogPath)) {
      changelog = fs.readFileSync(changelogPath, 'utf8');
      console.log('📖 Reading existing CHANGELOG.md');
    } else {
      console.log('📝 CHANGELOG.md does not exist, creating new file');
    }
    
    // Extract the header and unreleased section
    const lines = changelog.split('\n');
    const headerEndIndex = lines.findIndex(line => line.startsWith('## [Unreleased]'));
    const unreleasedEndIndex = lines.findIndex((line, index) => 
      index > headerEndIndex && line.startsWith('## [') && !line.includes('Unreleased')
    );
    
    let header = '';
    let unreleasedSection = '';
    
    if (headerEndIndex >= 0) {
      header = lines.slice(0, headerEndIndex + 1).join('\n');
      if (unreleasedEndIndex >= 0) {
        unreleasedSection = lines.slice(headerEndIndex + 1, unreleasedEndIndex).join('\n');
      } else {
        // Take everything after unreleased header until we find a release or end
        const restOfFile = lines.slice(headerEndIndex + 1);
        const nextReleaseIndex = restOfFile.findIndex(line => line.startsWith('## [') && !line.includes('Unreleased'));
        if (nextReleaseIndex >= 0) {
          unreleasedSection = restOfFile.slice(0, nextReleaseIndex).join('\n');
        } else {
          unreleasedSection = restOfFile.join('\n');
        }
      }
    } else {
      // Create basic header if none exists
      header = '# Change Log\n\nAll notable changes to the "copilot-token-tracker" extension will be documented in this file.\n\nCheck [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.\n\n## [Unreleased]';
      unreleasedSection = '\n';
    }
    
    // Build new changelog content
    let newChangelog = header + unreleasedSection + '\n';
    
    console.log('✏️ Building changelog entries from releases...');
    
    // Add releases
    for (const release of releases) {
      const version = release.tagName.startsWith('v') ? release.tagName.substring(1) : release.tagName;
      const releaseType = release.isPrerelease ? ' - Pre-release' : '';
      
      newChangelog += `## [${version}]${releaseType}\n\n`;
      
      if (release.body && release.body.trim()) {
        // Clean up the release body
        let body = release.body.trim();
        
        // Remove any "Full Changelog" links at the end
        body = body.replace(/\*\*Full Changelog\*\*:.*$/gm, '').trim();
        
        // Ensure bullet points are properly formatted
        const bodyLines = body.split('\n').map(line => {
          line = line.trim();
          if (line && !line.startsWith('-') && !line.startsWith('*') && !line.startsWith('#')) {
            return `- ${line}`;
          }
          return line;
        }).filter(line => line.length > 0);
        
        newChangelog += bodyLines.join('\n') + '\n\n';
      } else {
        newChangelog += `- Release ${version}\n\n`;
      }
    }
    
    // Write the new changelog
    fs.writeFileSync(changelogPath, newChangelog.trim() + '\n');
    console.log('💾 CHANGELOG.md updated successfully!');
    
    // Show what changed
    try {
      const diff = execSync('git diff CHANGELOG.md', { encoding: 'utf8' });
      if (diff.trim()) {
        console.log('\n📊 Changes made to CHANGELOG.md:');
        console.log(diff);
        console.log('\n✅ Sync completed successfully! Review the changes and commit them when ready.');
      } else {
        console.log('ℹ️ No changes needed - CHANGELOG.md is already up to date');
      }
    } catch (error) {
      console.log('💡 Could not show diff, but file was updated');
      console.log('✅ Sync completed successfully!');
    }
    
  } catch (error) {
    console.error('❌ Error syncing release notes:', error.message);
    process.exit(1);
  }
}

// Run the sync if this script is executed directly
if (require.main === module) {
  syncReleaseNotes();
}

module.exports = { syncReleaseNotes };