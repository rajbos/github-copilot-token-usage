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

	/** IDs passed as a literal first argument to registerCommand(...); plain mentions of an id do not count. */
	function literalRegistrations(): Set<string> {
		const ids = new Set<string>();
		for (const m of source.matchAll(/registerCommand\(\s*["'`]([^"'`$]+)["'`]/g)) {
			ids.add(m[1]);
		}
		return ids;
	}

	/** Names in the backendCommandHandlers table, which a loop registers as aiEngineeringFluency.<name>. */
	function tableRegistrations(): Set<string> {
		const ids = new Set<string>();
		const table = source.match(/const backendCommandHandlers[^\n]*>\s*=\s*\[([\s\S]*?)\n\s*\];/);
		const loopRegisters = /registerCommand\(\s*`aiEngineeringFluency\.\$\{id\}`/.test(source);
		if (table && loopRegisters) {
			for (const m of table[1].matchAll(/\[\s*"([^"]+)"\s*,/g)) {
				ids.add(`aiEngineeringFluency.${m[1]}`);
			}
		}
		return ids;
	}

	test('every contributed command has a registerCommand call in extension.ts', () => {
		const registered = new Set([...literalRegistrations(), ...tableRegistrations()]);
		const missing = contributed.filter((id) => !INTENTIONALLY_UNREGISTERED.includes(id) && !registered.has(id));
		assert.deepEqual(missing, [], `Contributed but never registered: ${missing.join(', ')}`);
	});

	test('the exclusion list contains only contributed commands', () => {
		for (const id of INTENTIONALLY_UNREGISTERED) {
			assert.ok(contributed.includes(id), `${id} is excluded but not contributed`);
		}
	});
});
