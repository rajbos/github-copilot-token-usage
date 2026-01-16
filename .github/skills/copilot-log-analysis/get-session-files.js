#!/usr/bin/env node
/**
 * Get Session Files Script
 * 
 * This script discovers all GitHub Copilot session files on the system.
 * It scans all VS Code variants (Stable, Insiders, Cursor, VSCodium, etc.)
 * and all storage locations (workspace, global, CLI).
 * 
 * Uses shared discovery logic from session-file-discovery.js module.
 * The extension in src/extension.ts maintains its own TypeScript implementation
 * that should mirror the logic in session-file-discovery.js.
 * 
 * Usage:
 *   node .github/skills/copilot-log-analysis/get-session-files.js [--verbose] [--json]
 * 
 * Options:
 *   --verbose    Show all file paths
 *   --json       Output as JSON
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { 
    getCopilotSessionFiles, 
    categorizeFile, 
    getEditorType 
} = require('./session-file-discovery');

// Parse command line arguments
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const jsonOutput = args.includes('--json');

// Execute discovery
const { sessionFiles, foundPaths } = getCopilotSessionFiles();

// Output results
(function displayResults() {
    if (jsonOutput) {
        // JSON output for programmatic use
        const result = {
            platform: os.platform(),
            homeDirectory: os.homedir(),
            totalFiles: sessionFiles.length,
            vscodePathsFound: foundPaths,
            files: sessionFiles.map(file => ({
                path: file,
                category: categorizeFile(file),
                editorType: getEditorType(file),
                size: fs.statSync(file).size,
                modified: fs.statSync(file).mtime
            }))
        };
        console.log(JSON.stringify(result, null, 2));
    } else {
        // Human-readable output
        console.log('Platform:', os.platform());
        console.log('Home directory:', os.homedir());
        console.log('');
        
        console.log('VS Code installations found:');
        foundPaths.forEach(p => console.log('  ' + p));
        console.log('');
        
        console.log('Total session files found:', sessionFiles.length);
        console.log('');
        
        if (sessionFiles.length > 0) {
            console.log('Session files by location:');
            const byLocation = {};
            sessionFiles.forEach(file => {
                const location = categorizeFile(file);
                byLocation[location] = (byLocation[location] || 0) + 1;
            });
            Object.entries(byLocation).forEach(([loc, count]) => {
                console.log(`  ${loc}: ${count} files`);
            });
            
            console.log('');
            console.log('Session files by editor:');
            const byEditor = {};
            sessionFiles.forEach(file => {
                const editor = getEditorType(file);
                byEditor[editor] = (byEditor[editor] || 0) + 1;
            });
            Object.entries(byEditor).forEach(([editor, count]) => {
                console.log(`  ${editor}: ${count} files`);
            });
            
            if (verbose) {
                console.log('');
                console.log('All session files:');
                sessionFiles.forEach((file, i) => {
                    console.log(`  ${i + 1}. ${file}`);
                });
            } else {
                console.log('');
                console.log('Sample files (first 10):');
                sessionFiles.slice(0, 10).forEach((file, i) => {
                    console.log(`  ${i + 1}. ${file}`);
                });
                if (sessionFiles.length > 10) {
                    console.log(`  ... and ${sessionFiles.length - 10} more files`);
                    console.log('');
                    console.log('Use --verbose to see all file paths');
                }
            }
        } else {
            console.log('No session files found. Possible reasons:');
            console.log('  - GitHub Copilot Chat extension not installed or active');
            console.log('  - No chat conversations started yet');
            console.log('  - Need to authenticate with GitHub Copilot');
        }
    }
});
