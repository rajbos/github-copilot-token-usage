import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Tests run from out/vscode-extension/test/unit; walk up to the package root.
function findPackageRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 8; i++) {
		if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src', 'extension.ts'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error('vscode-extension root not found');
}

// Commands that are contributed but intentionally not registered in extension.ts.
const INTENTIONALLY_UNREGISTERED: string[] = [];

describe('contributed commands are registered', () => {
	const root = findPackageRoot();
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
	const contributed: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);

	test('every contributed command has a registerCommand in extension.ts', () => {
		const missing = contributed.filter((id) => {
			if (INTENTIONALLY_UNREGISTERED.includes(id)) {
				return false;
			}
			const [prefix, name] = id.split('.');
			// Either the full id literal, or the `${prefix}.${name}` template used for loops.
			return !source.includes(`"${id}"`) && !source.includes(`'${id}'`) &&
				!(prefix === 'aiEngineeringFluency' && source.includes(`["${name}",`));
		});
		assert.deepEqual(missing, [], `Contributed but never registered: ${missing.join(', ')}`);
	});

	test('the exclusion list contains only contributed commands', () => {
		for (const id of INTENTIONALLY_UNREGISTERED) {
			assert.ok(contributed.includes(id), `${id} is excluded but not contributed`);
		}
	});
});
