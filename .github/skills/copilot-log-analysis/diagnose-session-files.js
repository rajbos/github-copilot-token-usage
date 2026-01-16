#!/usr/bin/env node
/**
 * Copilot Session File Diagnostic Script
 * 
 * This script scans for GitHub Copilot Chat session files across all known locations
 * on any VS Code installation (stable, Insiders, remote, etc.) and reports what it finds.
 * 
 * Usage: node .github/skills/copilot-log-analysis/diagnose-session-files.js
 * 
 * Can be run directly from the terminal on any machine to diagnose session file discovery issues.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m'
};

function log(message, color = colors.reset) {
    console.log(`${color}${message}${colors.reset}`);
}

function logHeader(message) {
    console.log('');
    log('═'.repeat(70), colors.cyan);
    log(`  ${message}`, colors.bright + colors.cyan);
    log('═'.repeat(70), colors.cyan);
}

function logSection(message) {
    console.log('');
    log(`▶ ${message}`, colors.bright + colors.blue);
    log('─'.repeat(50), colors.dim);
}

function logSuccess(message) {
    log(`  ✅ ${message}`, colors.green);
}

function logWarning(message) {
    log(`  ⚠️  ${message}`, colors.yellow);
}

function logError(message) {
    log(`  ❌ ${message}`, colors.red);
}

function logInfo(message) {
    log(`  ℹ️  ${message}`, colors.dim);
}

function logFile(filePath, stats) {
    const sizeKb = (stats.size / 1024).toFixed(2);
    const modified = stats.mtime.toISOString();
    log(`     📄 ${path.basename(filePath)}`, colors.reset);
    log(`        Size: ${sizeKb} KB | Modified: ${modified}`, colors.dim);
}

/**
 * Get all possible VS Code user data paths for all VS Code variants
 */
function getAllVSCodePaths() {
    const platform = os.platform();
    const homedir = os.homedir();
    const paths = [];

    // VS Code stable folder names
    const vscodeVariants = [
        'Code',               // Stable
        'Code - Insiders',    // Insiders
        'Code - Exploration', // Exploration
        'VSCodium',           // VSCodium
        'code-server',        // code-server
        'Cursor'              // Cursor editor (Copilot compatible)
    ];

    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
        for (const variant of vscodeVariants) {
            paths.push({
                type: variant,
                userPath: path.join(appData, variant, 'User'),
                platform: 'Windows'
            });
        }
    } else if (platform === 'darwin') {
        for (const variant of vscodeVariants) {
            paths.push({
                type: variant,
                userPath: path.join(homedir, 'Library', 'Application Support', variant, 'User'),
                platform: 'macOS'
            });
        }
    } else {
        // Linux - check both XDG and default paths
        const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
        for (const variant of vscodeVariants) {
            paths.push({
                type: variant,
                userPath: path.join(xdgConfigHome, variant, 'User'),
                platform: 'Linux'
            });
        }
    }

    // Remote/Server paths (used in Codespaces, WSL, SSH remotes)
    const remotePaths = [
        path.join(homedir, '.vscode-server', 'data', 'User'),
        path.join(homedir, '.vscode-server-insiders', 'data', 'User'),
        path.join(homedir, '.vscode-remote', 'data', 'User'),
        '/tmp/.vscode-server/data/User',
        '/workspace/.vscode-server/data/User'
    ];

    for (const remotePath of remotePaths) {
        paths.push({
            type: 'VS Code Server/Remote',
            userPath: remotePath,
            platform: 'Remote'
        });
    }

    return paths;
}

/**
 * Get the new Copilot CLI session-state directory
 * This is where the newer Copilot agent stores sessions as .jsonl files
 */
function getCopilotCliSessionPaths() {
    const homedir = os.homedir();
    return [
        {
            type: 'Copilot CLI Sessions',
            path: path.join(homedir, '.copilot', 'session-state'),
            description: 'New Copilot agent sessions (.jsonl files)'
        }
    ];
}

/**
 * Scan a workspace storage path for chatSessions directories
 */
function scanWorkspaceStorage(workspaceStoragePath) {
    const sessionFiles = [];

    if (!fs.existsSync(workspaceStoragePath)) {
        return sessionFiles;
    }

    try {
        const workspaceDirs = fs.readdirSync(workspaceStoragePath);
        for (const workspaceDir of workspaceDirs) {
            const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
            if (fs.existsSync(chatSessionsPath)) {
                try {
                    const files = fs.readdirSync(chatSessionsPath);
                    for (const file of files) {
                        if (file.endsWith('.json')) {
                            const filePath = path.join(chatSessionsPath, file);
                            try {
                                const stats = fs.statSync(filePath);
                                sessionFiles.push({ filePath, stats, workspace: workspaceDir });
                            } catch (e) { /* ignore */ }
                        }
                    }
                } catch (e) { /* ignore */ }
            }
        }
    } catch (e) { /* ignore */ }

    return sessionFiles;
}

/**
 * Scan global storage for session files
 */
function scanGlobalStorage(userPath) {
    const sessionFiles = [];

    // Check emptyWindowChatSessions (legacy location)
    const emptyWindowPath = path.join(userPath, 'globalStorage', 'emptyWindowChatSessions');
    if (fs.existsSync(emptyWindowPath)) {
        try {
            const files = fs.readdirSync(emptyWindowPath);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(emptyWindowPath, file);
                    try {
                        const stats = fs.statSync(filePath);
                        sessionFiles.push({ filePath, stats, location: 'emptyWindowChatSessions' });
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }
    }

    // Check github.copilot-chat global storage
    const copilotChatPath = path.join(userPath, 'globalStorage', 'github.copilot-chat');
    if (fs.existsSync(copilotChatPath)) {
        try {
            // Recursively find all session-like files
            const findSessionFiles = (dir) => {
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            findSessionFiles(fullPath);
                        } else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
                            try {
                                const stats = fs.statSync(fullPath);
                                sessionFiles.push({ filePath: fullPath, stats, location: 'github.copilot-chat' });
                            } catch (e) { /* ignore */ }
                        }
                    }
                } catch (e) { /* ignore */ }
            };
            findSessionFiles(copilotChatPath);
        } catch (e) { /* ignore */ }
    }

    return sessionFiles;
}

/**
 * Scan Copilot CLI session-state directory
 */
function scanCopilotCliSessions(sessionStatePath) {
    const sessionFiles = [];

    if (!fs.existsSync(sessionStatePath)) {
        return sessionFiles;
    }

    try {
        const files = fs.readdirSync(sessionStatePath);
        for (const file of files) {
            if (file.endsWith('.jsonl') || file.endsWith('.json')) {
                const filePath = path.join(sessionStatePath, file);
                try {
                    const stats = fs.statSync(filePath);
                    sessionFiles.push({ filePath, stats, location: 'session-state' });
                } catch (e) { /* ignore */ }
            }
        }
    } catch (e) { /* ignore */ }

    return sessionFiles;
}

/**
 * Filter files modified today
 */
function filterFilesModifiedToday(files) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return files.filter(f => {
        const fileDate = new Date(f.stats.mtime);
        fileDate.setHours(0, 0, 0, 0);
        return fileDate.getTime() === today.getTime();
    });
}

/**
 * Main diagnostic function
 */
function runDiagnostics() {
    logHeader('GitHub Copilot Session File Diagnostic Tool');
    log(`  Date: ${new Date().toISOString()}`, colors.dim);

    logSection('System Information');
    log(`  Platform: ${os.platform()} (${os.arch()})`, colors.reset);
    log(`  Home directory: ${os.homedir()}`, colors.reset);
    log(`  Node version: ${process.version}`, colors.reset);

    // Environment detection
    const isCodespaces = process.env.CODESPACES === 'true';
    const isVSCodeServer = !!(process.env.VSCODE_IPC_HOOK_CLI || process.env.VSCODE_SERVER);
    log(`  GitHub Codespaces: ${isCodespaces ? 'Yes' : 'No'}`, colors.reset);
    log(`  VS Code Server: ${isVSCodeServer ? 'Yes' : 'No'}`, colors.reset);

    const allSessionFiles = [];
    const vscodePaths = getAllVSCodePaths();
    const copilotCliPaths = getCopilotCliSessionPaths();

    // Scan VS Code paths
    logSection('Scanning VS Code Installations');

    for (const vscodeInfo of vscodePaths) {
        const exists = fs.existsSync(vscodeInfo.userPath);
        
        if (exists) {
            logSuccess(`Found ${vscodeInfo.type} (${vscodeInfo.platform})`);
            log(`     Path: ${vscodeInfo.userPath}`, colors.dim);

            // Scan workspace storage
            const workspaceStoragePath = path.join(vscodeInfo.userPath, 'workspaceStorage');
            const workspaceFiles = scanWorkspaceStorage(workspaceStoragePath);
            if (workspaceFiles.length > 0) {
                log(`     📁 Workspace Sessions: ${workspaceFiles.length} files`, colors.green);
                for (const f of workspaceFiles) {
                    allSessionFiles.push({ ...f, source: `${vscodeInfo.type} (workspace)` });
                }
            }

            // Scan global storage
            const globalFiles = scanGlobalStorage(vscodeInfo.userPath);
            if (globalFiles.length > 0) {
                log(`     📁 Global Sessions: ${globalFiles.length} files`, colors.green);
                for (const f of globalFiles) {
                    allSessionFiles.push({ ...f, source: `${vscodeInfo.type} (global)` });
                }
            }

            if (workspaceFiles.length === 0 && globalFiles.length === 0) {
                logInfo(`No session files found in ${vscodeInfo.type}`);
            }
        }
    }

    // Scan Copilot CLI session-state
    logSection('Scanning Copilot CLI Sessions');

    for (const cliPath of copilotCliPaths) {
        const exists = fs.existsSync(cliPath.path);
        
        if (exists) {
            logSuccess(`Found ${cliPath.type}`);
            log(`     Path: ${cliPath.path}`, colors.dim);
            log(`     Description: ${cliPath.description}`, colors.dim);

            const cliFiles = scanCopilotCliSessions(cliPath.path);
            if (cliFiles.length > 0) {
                log(`     📁 Sessions: ${cliFiles.length} files`, colors.green);
                for (const f of cliFiles) {
                    allSessionFiles.push({ ...f, source: 'Copilot CLI' });
                }
            } else {
                logInfo('No session files found');
            }
        } else {
            logInfo(`${cliPath.type} directory not found: ${cliPath.path}`);
        }
    }

    // Summary
    logSection('Summary');
    log(`  Total session files found: ${allSessionFiles.length}`, colors.bright);

    // Files modified today
    const todayFiles = filterFilesModifiedToday(allSessionFiles);
    log(`  Files modified today: ${todayFiles.length}`, colors.bright + colors.green);

    if (todayFiles.length > 0) {
        logSection('Files Modified Today');
        for (const f of todayFiles) {
            log(`  ${f.source}:`, colors.blue);
            logFile(f.filePath, f.stats);
        }
    }

    // Group by source
    logSection('Files by Source');
    const bySource = {};
    for (const f of allSessionFiles) {
        bySource[f.source] = (bySource[f.source] || 0) + 1;
    }
    for (const [source, count] of Object.entries(bySource)) {
        log(`  ${source}: ${count} files`, colors.reset);
    }

    // Recommendations
    if (allSessionFiles.length === 0) {
        logSection('Troubleshooting Recommendations');
        logWarning('No session files found. This could mean:');
        log('  1. GitHub Copilot Chat has not been used yet', colors.dim);
        log('  2. The Copilot Chat extension is not installed or activated', colors.dim);
        log('  3. Sessions are stored in an unknown location', colors.dim);
        log('  4. You need to start a Copilot Chat conversation first', colors.dim);
        console.log('');
        log('  Try:', colors.bright);
        log('  - Open VS Code and start a Copilot Chat conversation', colors.reset);
        log('  - Check if the GitHub Copilot Chat extension is installed', colors.reset);
        log('  - Run this script again after using Copilot Chat', colors.reset);
    }

    if (todayFiles.length === 0 && allSessionFiles.length > 0) {
        logSection('Note');
        logInfo(`Found ${allSessionFiles.length} session files, but none modified today.`);
        logInfo('The extension should show data from previously recorded sessions.');
    }

    // Print all file paths for debugging
    if (allSessionFiles.length > 0 && process.argv.includes('--verbose')) {
        logSection('All Session File Paths (--verbose)');
        for (const f of allSessionFiles) {
            log(`  ${f.filePath}`, colors.dim);
        }
    }

    logHeader('Diagnostic Complete');
    log(`  Run with --verbose to see all file paths`, colors.dim);
    
    return {
        totalFiles: allSessionFiles.length,
        todayFiles: todayFiles.length,
        files: allSessionFiles
    };
}

// Run if called directly
if (require.main === module) {
    runDiagnostics();
}

module.exports = { runDiagnostics, getAllVSCodePaths, getCopilotCliSessionPaths };
