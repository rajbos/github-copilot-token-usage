const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const extensionRoot = path.join(repoRoot, 'vscode-extension');
const outDir = path.join(extensionRoot, 'out');
const outTestDir = path.join(outDir, 'test');
const packageJsonPath = path.join(extensionRoot, 'package.json');

fs.mkdirSync(outTestDir, { recursive: true });
fs.cpSync(packageJsonPath, path.join(outDir, 'package.json'), { force: true });
fs.cpSync(packageJsonPath, path.join(outTestDir, 'package.json'), { force: true });
