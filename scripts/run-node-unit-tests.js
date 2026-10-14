const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const extensionRoot = path.join(repoRoot, 'vscode-extension');
const outUnitDir = path.join(extensionRoot, 'out', 'vscode-extension', 'test', 'unit');
const shimPath = path.join(outUnitDir, 'vscode-shim-register.js');

const testFiles = fs.readdirSync(outUnitDir)
	.filter((name) => name.endsWith('.test.js'))
	.sort((a, b) => a.localeCompare(b));

// Run every file even after a failure, so one failing file cannot hide the
// results of the files sorted after it; exit non-zero at the end instead.
const failed = [];

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

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		if (result.stdout) {
			process.stdout.write(result.stdout);
		}

		if (result.stderr) {
			process.stderr.write(result.stderr);
		}

		process.stdout.write(`FAIL ${fileName}\n`);
		failed.push({ fileName, status: result.status ?? 1 });
		continue;
	}

	process.stdout.write(`PASS ${fileName}\n`);
}

if (failed.length > 0) {
	const list = failed.map((f) => `  ${f.fileName}`).join('\n');
	process.stderr.write(`\n${failed.length} of ${testFiles.length} test file(s) failed:\n${list}\n`);
	process.exit(failed[0].status);
}
