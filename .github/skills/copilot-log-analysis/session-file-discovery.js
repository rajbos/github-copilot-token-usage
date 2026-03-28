/**
 * Session File Discovery Module
 * 
 * Shared logic for discovering GitHub Copilot session files across all VS Code variants.
 * This module is used by both the standalone scripts and should be kept in sync with
 * the extension's TypeScript implementation in src/extension.ts.
 * 
 * IMPORTANT: This is the canonical JavaScript implementation. The TypeScript version in
 * src/extension.ts should mirror this logic. When updating discovery logic, update both.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Get all possible VS Code user data paths for all VS Code variants
 * Returns paths for: Code (stable), Code - Insiders, Code - Exploration, VSCodium, Cursor, and remote servers
 */
function getVSCodeUserPaths() {
    const platform = os.platform();
    const homedir = os.homedir();
    const paths = [];

    const vscodeVariants = [
        'Code',               // Stable
        'Code - Insiders',    // Insiders
        'Code - Exploration', // Exploration builds
        'VSCodium',           // VSCodium
        'Cursor'              // Cursor editor
    ];

    if (platform === 'win32') {
        const appDataPath = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
        for (const variant of vscodeVariants) {
            paths.push(path.join(appDataPath, variant, 'User'));
        }
    } else if (platform === 'darwin') {
        for (const variant of vscodeVariants) {
            paths.push(path.join(homedir, 'Library', 'Application Support', variant, 'User'));
        }
    } else {
        // Linux and other Unix-like systems
        const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
        for (const variant of vscodeVariants) {
            paths.push(path.join(xdgConfigHome, variant, 'User'));
        }
    }

    // Remote/Server paths (used in Codespaces, WSL, SSH remotes)
    const remotePaths = [
        path.join(homedir, '.vscode-server', 'data', 'User'),
        path.join(homedir, '.vscode-server-insiders', 'data', 'User'),
        path.join(homedir, '.vscode-remote', 'data', 'User'),
        path.join('/tmp', '.vscode-server', 'data', 'User'),
        path.join('/workspace', '.vscode-server', 'data', 'User')
    ];

    paths.push(...remotePaths);
    return paths;
}

/**
 * Recursively scan a directory for session files (.json and .jsonl)
 */
function scanDirectoryForSessionFiles(dir, sessionFiles) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scanDirectoryForSessionFiles(fullPath, sessionFiles);
            } else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
                try {
                    const stats = fs.statSync(fullPath);
                    if (stats.size > 0) {
                        sessionFiles.push(fullPath);
                    }
                } catch (e) {
                    // Ignore file access errors
                }
            }
        }
    } catch (error) {
        // Ignore directory access errors
    }
}

/**
 * Discover all GitHub Copilot session files on the system
 * Returns: { sessionFiles: string[], foundPaths: string[] }
 */
function getCopilotSessionFiles() {
    const sessionFiles = [];
    const homedir = os.homedir();

    const allVSCodePaths = getVSCodeUserPaths();
    const foundPaths = [];
    
    // Find which VS Code paths actually exist
    for (const codeUserPath of allVSCodePaths) {
        if (fs.existsSync(codeUserPath)) {
            foundPaths.push(codeUserPath);
        }
    }

    // Scan workspace storage in all found VS Code installations
    for (const codeUserPath of foundPaths) {
        // Workspace storage sessions
        const workspaceStoragePath = path.join(codeUserPath, 'workspaceStorage');
        if (fs.existsSync(workspaceStoragePath)) {
            const workspaceDirs = fs.readdirSync(workspaceStoragePath);
            for (const workspaceDir of workspaceDirs) {
                const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
                if (fs.existsSync(chatSessionsPath)) {
                    const files = fs.readdirSync(chatSessionsPath)
                        .filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
                        .map(file => path.join(chatSessionsPath, file));
                    sessionFiles.push(...files);
                }
            }
        }

        // Global storage sessions (legacy emptyWindowChatSessions)
        const globalStoragePath = path.join(codeUserPath, 'globalStorage', 'emptyWindowChatSessions');
        if (fs.existsSync(globalStoragePath)) {
            const files = fs.readdirSync(globalStoragePath)
                .filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
                .map(file => path.join(globalStoragePath, file));
            sessionFiles.push(...files);
        }

        // GitHub Copilot Chat extension global storage
        const copilotChatGlobalPath = path.join(codeUserPath, 'globalStorage', 'github.copilot-chat');
        if (fs.existsSync(copilotChatGlobalPath)) {
            scanDirectoryForSessionFiles(copilotChatGlobalPath, sessionFiles);
        }
    }

    // Copilot CLI session-state directory (new location for agent mode sessions)
    const copilotCliSessionPath = path.join(homedir, '.copilot', 'session-state');
    if (fs.existsSync(copilotCliSessionPath)) {
        const files = fs.readdirSync(copilotCliSessionPath)
            .filter(file => file.endsWith('.json') || file.endsWith('.jsonl'))
            .map(file => path.join(copilotCliSessionPath, file));
        sessionFiles.push(...files);
    }

    // OpenCode session files (XDG data directory)
    const xdgDataHome = (platform === 'win32')
        ? path.join(homedir, '.local', 'share')
        : (process.env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'));
    const openCodeSessionDir = path.join(xdgDataHome, 'opencode', 'storage', 'session');
    if (fs.existsSync(openCodeSessionDir)) {
        const scanOpenCode = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        scanOpenCode(path.join(dir, entry.name));
                    } else if (entry.name.startsWith('ses_') && entry.name.endsWith('.json')) {
                        const fullPath = path.join(dir, entry.name);
                        try {
                            const stats = fs.statSync(fullPath);
                            if (stats.size > 0) { sessionFiles.push(fullPath); }
                        } catch { /* ignore */ }
                    }
                }
            } catch { /* ignore */ }
        };
        scanOpenCode(openCodeSessionDir);
    }

    return { sessionFiles, foundPaths };
}

/**
 * Categorize a session file by its location
 */
function categorizeFile(filePath) {
    if (filePath.includes('workspaceStorage')) return 'Workspace Storage';
    if (filePath.includes('emptyWindowChatSessions')) return 'Global Storage (Legacy)';
    if (filePath.includes('github.copilot-chat')) return 'Copilot Chat Extension';
    if (filePath.includes('.copilot')) return 'Copilot CLI';
    if (filePath.includes('opencode')) return 'OpenCode';
    return 'Unknown';
}

/**
 * Determine the editor type from a session file path
 */
function getEditorType(filePath) {
    const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
    
    if (normalizedPath.includes('/.copilot/session-state/')) return 'Copilot CLI';
    if (normalizedPath.includes('/opencode/storage/session/')) return 'OpenCode';
    if (normalizedPath.includes('/code - insiders/') || normalizedPath.includes('/code%20-%20insiders/')) return 'VS Code Insiders';
    if (normalizedPath.includes('/code - exploration/') || normalizedPath.includes('/code%20-%20exploration/')) return 'VS Code Exploration';
    if (normalizedPath.includes('/vscodium/')) return 'VSCodium';
    if (normalizedPath.includes('/cursor/')) return 'Cursor';
    if (normalizedPath.includes('.vscode-server-insiders/')) return 'VS Code Server (Insiders)';
    if (normalizedPath.includes('.vscode-server/') || normalizedPath.includes('.vscode-remote/')) return 'VS Code Server';
    if (normalizedPath.includes('/code/')) return 'VS Code';
    
    return 'Unknown';
}

module.exports = {
    getVSCodeUserPaths,
    scanDirectoryForSessionFiles,
    getCopilotSessionFiles,
    categorizeFile,
    getEditorType
};
