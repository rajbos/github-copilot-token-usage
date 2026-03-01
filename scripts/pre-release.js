#!/usr/bin/env node

/**
 * Pre-release automation script.
 * Run before triggering the GitHub Actions release workflow.
 *
 * Steps performed:
 *   0. Preflight  — read version from package.json, confirm with user
 *   1. Build      — run `npm run compile`
 *   2. Timestamps — set sample session file mtimes spread over 30 days
 *   3. Screenshots— invoke scripts/capture-screenshots.ps1 (Windows only)
 *   4. CONTRIBUTING.md — upsert pre-release checklist section
 *   5. Changelog  — sync from GitHub releases via scripts/sync-changelog.js
 *
 * Usage:
 *   node scripts/pre-release.js [options]
 *   npm run pre-release
 *
 * Options:
 *   --skip-build        Skip npm compile step
 *   --skip-screenshots  Skip screenshot capture
 *   --startup-wait=N    Seconds to wait for VS Code to fully load (default: 8)
 *   --panel-wait=N      Seconds to wait after opening each panel (default: 4)
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const skipBuild       = args.includes('--skip-build');
const skipScreenshots = args.includes('--skip-screenshots');
const startupWait     = Number((args.find(a => a.startsWith('--startup-wait=')) || '').split('=')[1] || 8);
const panelWait       = Number((args.find(a => a.startsWith('--panel-wait='))   || '').split('=')[1] || 4);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function step(msg) { console.log(`\n▶  ${msg}`); }
function ok(msg)   { console.log(`   ✅ ${msg}`); }
function warn(msg) { console.log(`   ⚠️  ${msg}`); }
function note(msg) { console.log(`   ℹ️  ${msg}`); }

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    // ── Step 0: Preflight ────────────────────────────────────────────────────
    step('Preflight checks');

    const pkg     = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const version = pkg.version;

    console.log(`\n   Current version in package.json: \x1b[33m${version}\x1b[0m`);

    const confirm = await prompt('   Is this the correct version for the release? [y/N] ');
    if (!['y', 'yes'].includes(confirm.toLowerCase())) {
        console.log('\n   ❌ Aborted. Update the version in package.json first, then re-run.');
        process.exit(1);
    }
    ok(`Version ${version} confirmed`);

    // ── Step 1: Build ────────────────────────────────────────────────────────
    step('Building extension');
    if (!skipBuild) {
        try {
            execSync('npm run compile', { cwd: ROOT, stdio: 'inherit' });
            ok('Build succeeded');
        } catch {
            console.error('\n   ❌ Build failed. Fix errors and retry.');
            process.exit(1);
        }
    } else {
        warn('Build skipped (--skip-build)');
    }

    // ── Step 2: Sample data timestamps ───────────────────────────────────────
    step('Setting sample session file timestamps (historical spread over 30 days)');

    const sampleDir = path.join(ROOT, 'test', 'sample-session-data', 'chatSessions');
    const now = new Date();
    const fileOffsets = {
        'session-01-today.json':                  0,
        'session-02-five-days-ago.json':          -5,
        'session-03-twelve-days-ago.json':        -12,
        'session-04-twenty-days-ago.json':        -20,
        'session-05-twenty-seven-days-ago.json':  -27,
    };

    for (const [filename, daysAgo] of Object.entries(fileOffsets)) {
        const filePath = path.join(sampleDir, filename);
        if (fs.existsSync(filePath)) {
            const ts = new Date(now.getTime() + daysAgo * 24 * 60 * 60 * 1000);
            fs.utimesSync(filePath, ts, ts);
            note(`${filename} → ${ts.toISOString().split('T')[0]}`);
        } else {
            warn(`Sample file not found: ${filename}`);
        }
    }
    ok('Timestamps updated');

    // ── Step 3: Screenshots ───────────────────────────────────────────────────
    step('Capturing screenshots');
    if (skipScreenshots) {
        warn('Screenshot capture skipped (--skip-screenshots)');
    } else if (process.platform !== 'win32') {
        warn('Screenshot capture is only supported on Windows (requires Win32 APIs). Skipped.');
    } else {
        const captureScript = path.join(__dirname, 'capture-screenshots.ps1');
        if (!fs.existsSync(captureScript)) {
            warn(`Screenshot script not found: ${captureScript}`);
        } else {
            const imagesPath = path.join(ROOT, 'docs', 'images');
            try {
                execSync(
                    `powershell.exe -ExecutionPolicy Bypass -File "${captureScript}"` +
                    ` -VsCodeStartupWait ${startupWait} -PanelRenderWait ${panelWait}` +
                    ` -ExtensionPath "${ROOT}" -ImagesOutputPath "${imagesPath}"`,
                    { cwd: ROOT, stdio: 'inherit' }
                );
            } catch {
                warn('Screenshot capture returned non-zero exit. Review output above.');
            }
        }
    }

    // ── Step 4: CONTRIBUTING.md ───────────────────────────────────────────────
    step('Updating CONTRIBUTING.md Pre-Release Checklist');
    updateContributingChecklist(path.join(ROOT, 'CONTRIBUTING.md'), version);
    ok(`CONTRIBUTING.md updated (version ${version}, date ${now.toISOString().split('T')[0]})`);

    // ── Done ──────────────────────────────────────────────────────────────────
    console.log('');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`  ✅  Pre-release preparation complete for v${version}`);
    console.log('════════════════════════════════════════════════════════════');
    console.log('');
    console.log('  Next steps:');
    console.log('  1. Review docs/images/ screenshots and update manually if needed');
    console.log('  2. Commit changes (screenshots + CONTRIBUTING.md)');
    console.log('  3. Push to main branch');
    console.log('  4. Trigger GitHub Actions Release workflow:');
    console.log('     https://github.com/rajbos/github-copilot-token-usage/actions');
    console.log('  5. Once the release exists, run ./publish.ps1 — it will sync');
    console.log('     CHANGELOG.md from the new release, build, and publish the VSIX.');
    console.log('  6. Commit and push the updated CHANGELOG.md after publishing.');
    console.log('');
}

// ─── CONTRIBUTING.md upsert ───────────────────────────────────────────────────

function updateContributingChecklist(filePath, version) {
    const today = new Date().toISOString().split('T')[0];
    const newSection =
        `## Pre-Release Checklist\n\n` +
        `Version: ${version} | Last run: ${today}\n\n` +
        `Run \`npm run pre-release\` to automate steps 1–3 below.\n\n` +
        `- [ ] Version bumped in \`package.json\`\n` +
        `- [ ] \`npm run compile\` completed successfully\n` +
        `- [ ] Screenshots updated in \`docs/images/\` (run \`npm run pre-release\` or update manually)\n` +
        `- [ ] Commit and push to main branch\n` +
        `- [ ] Trigger GitHub Actions Release workflow (Method 1: GitHub UI → Actions → Release → Run workflow)\n` +
        `- [ ] Run \`./publish.ps1\` — syncs \`CHANGELOG.md\` from the new release, builds the VSIX, and publishes to the marketplace\n` +
        `- [ ] Commit and push the updated \`CHANGELOG.md\`\n`;

    let content = fs.readFileSync(filePath, 'utf8');

    if (content.includes('## Pre-Release Checklist')) {
        // Replace the existing section up to the next ## heading
        content = content.replace(/## Pre-Release Checklist[\s\S]*?(?=\n## )/, newSection + '\n');
    } else if (content.includes('## Release Process')) {
        content = content.replace('## Release Process', newSection + '\n## Release Process');
    } else {
        content += '\n' + newSection;
    }

    fs.writeFileSync(filePath, content, 'utf8');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
    main().catch(err => {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    });
}

module.exports = { updateContributingChecklist };
