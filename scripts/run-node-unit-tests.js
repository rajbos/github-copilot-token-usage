const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const extensionRoot = path.join(repoRoot, 'vscode-extension');
const outUnitDir = path.join(extensionRoot, 'out', 'test', 'unit');
const shimPath = path.join(outUnitDir, 'vscode-shim-register.js');

const testFiles = fs.readdirSync(outUnitDir)
	.filter((name) => name.endsWith('.test.js'))
	.sort((a, b) => a.localeCompare(b));

for (const fileName of testFiles) {
	const testFilePath = path.join(outUnitDir, fileName);
	const result = spawnSync(
		process.execPath,
		['--require', shimPath, '--test', '--test-force-exit', testFilePath],
		{
			cwd: extensionRoot,
			encoding: 'utf8',
		},
	);

	if (result.status !== 0) {
		if (result.stdout) {
			process.stdout.write(result.stdout);
		}

		if (result.stderr) {
			process.stderr.write(result.stderr);
		}

		process.exit(result.status ?? 1);
	}

	if (result.error) {
		throw result.error;
	}

	process.stdout.write(`PASS ${fileName}\n`);
}
