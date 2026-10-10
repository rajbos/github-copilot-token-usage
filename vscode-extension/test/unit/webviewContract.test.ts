import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmpFixtureDir } from './tmpFixtureDirs';

// The validator is plain CommonJS developer tooling that runs from the repo
// root, outside the extension's TypeScript program, so it is loaded by path.
const requireFromHere = createRequire(__filename);

/**
 * Walks up from the compiled test to the repo root.
 *
 * Tests compile into `vscode-extension/out/vscode-extension/test/unit`, so a
 * hardcoded `../../../..` is both unreadable and wrong the moment the output
 * layout shifts. Look for the marker file instead.
 */
function findRepoRoot(): string {
	let dir = __dirname;
	for (let i = 0; i < 10; i++) {
		if (fs.existsSync(path.join(dir, 'scripts', 'validate-webview-contract.js'))) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`Could not locate the repo root from ${__dirname}`);
}

const REPO_ROOT = findRepoRoot();
const contract = requireFromHere(
	path.join(REPO_ROOT, 'scripts', 'validate-webview-contract.js')
) as {
	collectPostedCommands: (files: string[]) => Map<string, { file: string; line: number }[]>;
	collectHandledCommandsFromAst: (files: string[]) => Set<string>;
	widenHandledFromText: (files: string[], handled: Set<string>) => Set<string>;
};

/** Writes `source` to a throwaway .ts file and returns its path. */
function fixture(source: string): string {
	const dir = makeTmpFixtureDir('contract-fixture-');
	const file = path.join(dir, 'fixture.ts');
	fs.writeFileSync(file, source);
	return file;
}

test('collectPostedCommands: finds commands posted from a webview', () => {
	const file = fixture(`
		declare const vscode: any;
		vscode.postMessage({ command: 'showDetails' });
		function onClick() { vscode.postMessage({ command: 'refresh', period: 'day' }); }
	`);
	const posted = contract.collectPostedCommands([file]);
	assert.deepEqual([...posted.keys()].sort(), ['refresh', 'showDetails']);
	assert.equal(posted.get('showDetails')![0].line, 3);
});

test('collectPostedCommands: treats `type` as a message name too', () => {
	// The backend config panels key on `type` rather than `command`.
	const file = fixture(`declare const p: any; p.webview.postMessage({ type: 'testResult', ok: true });`);
	assert.ok(contract.collectPostedCommands([file]).has('testResult'));
});

test('collectPostedCommands: ignores a command name it cannot resolve statically', () => {
	// A runtime-computed name is the interaction smoke test's job, not this one's;
	// guessing here would produce findings nobody can act on.
	const file = fixture(`declare const vscode: any; declare const name: string;
		vscode.postMessage({ command: name });`);
	assert.equal(contract.collectPostedCommands([file]).size, 0);
});

test('collectHandledCommandsFromAst: reads a switch over message.command', () => {
	const file = fixture(`
		declare const message: any;
		switch (message.command) {
			case 'refresh': break;
			case 'saveSortSettings': break;
		}
	`);
	const handled = contract.collectHandledCommandsFromAst([file]);
	assert.ok(handled.has('refresh'));
	assert.ok(handled.has('saveSortSettings'));
});

test('collectHandledCommandsFromAst: reads an === comparison', () => {
	const file = fixture(`declare const message: any;
		if (message.command === 'openToolPicker') { /* … */ }`);
	assert.ok(contract.collectHandledCommandsFromAst([file]).has('openToolPicker'));
});

test('collectHandledCommandsFromAst: reads a Record<string, …> dispatch map on a variable', () => {
	const file = fixture(`
		const handlers: Record<string, () => void> = {
			showChart: () => {},
			'openAgentPlugins': () => {},
		};
		void handlers;
	`);
	const handled = contract.collectHandledCommandsFromAst([file]);
	assert.ok(handled.has('showChart'));
	assert.ok(handled.has('openAgentPlugins'), 'quoted keys are unquoted');
});

test('collectHandledCommandsFromAst: reads a dispatch map returned from a method', () => {
	// This is the shape `_getAnalysisMessageHandlers` uses; missing it made 19
	// perfectly-wired commands look unhandled.
	const file = fixture(`
		class Tracker {
			private handlers(): Record<string, (m: any) => void> {
				return {
					loadRepoPrStats: () => {},
					usageWebviewReady: () => {},
				};
			}
		}
		void Tracker;
	`);
	const handled = contract.collectHandledCommandsFromAst([file]);
	assert.ok(handled.has('loadRepoPrStats'));
	assert.ok(handled.has('usageWebviewReady'));
});

test('collectHandledCommandsFromAst: a nested function\'s return is not read as the map', () => {
	const file = fixture(`
		function outer(): Record<string, () => unknown> {
			return {
				realHandler: () => {
					const inner = () => ({ notAHandler: 1 });
					return inner();
				},
			};
		}
		void outer;
	`);
	const handled = contract.collectHandledCommandsFromAst([file]);
	assert.ok(handled.has('realHandler'));
	assert.ok(!handled.has('notAHandler'));
});

test('widenHandledFromText: reaches handlers inside inline <script> template literals', () => {
	// loadingHtml.ts and the backend config panels ship their webview script as a
	// template string, which the AST sees as one opaque token.
	const file = fixture([
		'export const html = `<script>',
		"  window.addEventListener('message', (e) => {",
		"    if (e.data.command === 'loadingStep') { render(e.data); }",
		'  });',
		'</script>`;',
	].join('\n'));
	const handled = contract.widenHandledFromText([file], new Set<string>());
	assert.ok(handled.has('loadingStep'));
});

test('the repo\'s own webview messages all have a counterpart', async () => {
	// The real check, run as a test so a regression fails the unit suite too and
	// not only the preflight.
	const { spawnSync } = requireFromHere('node:child_process') as typeof import('node:child_process');
	const result = spawnSync(
		process.execPath,
		[path.join(REPO_ROOT, 'scripts', 'validate-webview-contract.js')],
		{ cwd: REPO_ROOT, encoding: 'utf8' }
	);
	assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
});
