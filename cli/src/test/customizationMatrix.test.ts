/**
 * buildCustomizationMatrix counts workspaces that have no agent instructions file.
 * Each accepted spelling must satisfy the check on its own, matching the shared
 * scanner (src/customizationPatterns.json), which is case-insensitive.
 */

import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildCustomizationMatrix } from '../helpers';

/** Build a VS Code-style session file whose workspace.json points at a temp workspace. */
function makeWorkspace(files: string[]): { root: string; sessionFile: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-custmatrix-'));
	const workspace = path.join(root, 'ws');
	fs.mkdirSync(workspace);
	for (const rel of files) {
		const abs = path.join(workspace, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, '# instructions');
	}
	const hashDir = path.join(root, 'workspaceStorage', 'abc123');
	const chatDir = path.join(hashDir, 'chatSessions');
	fs.mkdirSync(chatDir, { recursive: true });
	fs.writeFileSync(
		path.join(hashDir, 'workspace.json'),
		JSON.stringify({ folder: 'file:///' + workspace.replace(/\\/g, '/') })
	);
	const sessionFile = path.join(chatDir, 's1.json');
	fs.writeFileSync(sessionFile, '{}');
	return { root, sessionFile };
}

async function issuesFor(files: string[]): Promise<number | undefined> {
	const { root, sessionFile } = makeWorkspace(files);
	try {
		return (await buildCustomizationMatrix([sessionFile]))?.workspacesWithIssues;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('buildCustomizationMatrix: workspace without any instructions file has an issue', async () => {
	assert.equal(await issuesFor([]), 1);
});

for (const file of [
	'AGENTS.md',
	'agents.md',
	'CLAUDE.md',
	'claude.md',
	'.claude/CLAUDE.md',
	'.claude/claude.md',
	'.CLAUDE/claude.md',
	'.github/copilot-instructions.md',
]) {
	test(`buildCustomizationMatrix: ${file} alone satisfies the instructions check`, async () => {
		assert.equal(await issuesFor([file]), 0);
	});
}
