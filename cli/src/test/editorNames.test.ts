/**
 * Contract test for editor-name agreement between the CLI and the shared extension
 * helpers — see the `validate-editor-names` skill.
 *
 * The CLI's getEditorSourceFromPath() (cli/src/analysis.ts) and the extension's
 * getEditorTypeFromPath() (src/workspaceHelpers.ts) classify the same paths through
 * two hand-maintained substring ladders. They drift silently: nothing throws when a
 * path is labelled 'Visual Studio' by one and 'VS Code' by the other, the numbers just
 * land in the wrong bucket. These cases pin the three Visual Studio Copilot Chat
 * session roots (issue #2137) to the same answer on both sides.
 *
 * The Visual Studio expectations are duplicated from
 * vscode-extension/test/unit/workspaceHelpers.test.ts. The later cases import
 * getEditorTypeFromPath directly — the CLI test bundle aliases `vscode` to the CLI stub —
 * and assert both detectors return the same name for the same path.
 */

import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';

import { getEditorSourceFromPath } from '../analysis';
import { getEditorTypeFromPath } from '../../../src/workspaceHelpers';
import { MistralVibeDataAccess } from '../../../src/mistralvibe';
import { HermesDataAccess } from '../../../src/hermes';
import { CodexCliDataAccess } from '../../../src/codexcli';

const VS_SOLUTION = '/project/.vs/mysolution.sln/copilot-chat/abc123/sessions/uuid';
const VS_APPDATA = 'C:/Users/u/AppData/Local/Microsoft/VisualStudio/18.0_0a408795/VSGitHubCopilot/copilot-chat/b6662ded/sessions/80720523';
const SSMS = 'C:/Users/u/AppData/Local/Microsoft/SSMS/22.0_82a729ff/SSMSGitHubCopilot/copilot-chat/ca1642fb/sessions/7bb52dc2';

test('CLI labels per-solution Visual Studio sessions as Visual Studio', () => {
	assert.equal(getEditorSourceFromPath(VS_SOLUTION), 'Visual Studio');
});

test('CLI labels VSGitHubCopilot AppData sessions as Visual Studio', () => {
	// Chats started without a solution open, so no .vs folder exists (issue #2137).
	assert.equal(getEditorSourceFromPath(VS_APPDATA), 'Visual Studio');
});

test('CLI labels SSMS sessions as SSMS, matching VisualStudioAdapter.getDisplayName', () => {
	assert.equal(getEditorSourceFromPath(SSMS), 'SSMS');
});

test('CLI requires /sessions/ before calling a copilot-chat path Visual Studio', () => {
	// The extension's isVisualStudioPath() requires it; the CLI must agree.
	assert.notEqual(
		getEditorSourceFromPath('C:/Users/u/AppData/Local/Microsoft/VisualStudio/18.0/VSGitHubCopilot/copilot-chat/b6662ded/index.json'),
		'Visual Studio'
	);
	assert.notEqual(getEditorSourceFromPath('/project/.vs/mysolution.sln/copilot-chat/abc123/index.json'), 'Visual Studio');
});

test('CLI does not match an unrelated folder merely named VSGitHubCopilot', () => {
	assert.notEqual(
		getEditorSourceFromPath('C:/repos/vsgithubcopilot/docs/copilot-chat/notes/sessions/readme.md'),
		'Visual Studio'
	);
});

/** Assert the CLI and extension detectors agree on `expected` for `filePath`. */
function assertBothDetectors(filePath: string, expected: string): void {
	assert.equal(getEditorSourceFromPath(filePath), expected, `CLI: ${filePath}`);
	assert.equal(getEditorTypeFromPath(filePath), expected, `extension: ${filePath}`);
}

test('CLI labels Eclipse Copilot conversations as Eclipse, not VS Code', () => {
	// The workspace path can pass through a folder named 'code'.
	assertBothDetectors('C:/code/eclipse-ws/.metadata/.plugins/com.microsoft.copilot.eclipse/conversations/abc.json', 'Eclipse');
	assertBothDetectors('/home/u/eclipse-workspace/.metadata/.plugins/com.microsoft.copilot.eclipse/conversations/abc.json', 'Eclipse');
});

test('CLI labels Pi sessions as Pi', () => {
	assertBothDetectors('/home/u/.pi/agent/sessions/--home-u-code-repo--/2026-09-01T10-00-00_abc.jsonl', 'Pi');
	assertBothDetectors('C:\\Users\\u\\.pi\\agent\\sessions\\--C--code--\\2026-09-01T10-00-00_abc.jsonl', 'Pi');
});

test('CLI labels Devin CLI virtual DB paths as Devin CLI', () => {
	assertBothDetectors('C:/Users/u/AppData/Roaming/devin/cli/sessions.db#sess-123', 'Devin CLI');
	assertBothDetectors('/home/u/.local/share/devin/cli/sessions.db#sess-123', 'Devin CLI');
});

test('CLI labels Hermes virtual DB paths as Hermes', () => {
	assertBothDetectors('C:\\Users\\u\\AppData\\Local\\hermes\\state.db#20260726_204744_427b88', 'Hermes');
	assertBothDetectors('/home/u/.hermes/state.db#20260726_204744_427b88', 'Hermes');
});

// ── Relocated agent homes ($CODEX_HOME / $VIBE_HOME / $HERMES_HOME) ────────────────────

const HOME_VARS = ['CODEX_HOME', 'VIBE_HOME', 'HERMES_HOME'] as const;

/** Run `fn` with the agent-home env vars set to `values` (others unset), restoring them afterwards. */
function withAgentHomes(values: Partial<Record<typeof HOME_VARS[number], string>>, fn: () => void): void {
	const saved = HOME_VARS.map(name => [name, process.env[name]] as const);
	try {
		for (const name of HOME_VARS) { delete process.env[name]; }
		Object.assign(process.env, values);
		fn();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; }
		}
	}
}

const CUSTOM_ROOT = path.join(os.tmpdir(), 'aef-editor-names', 'Agent Data');

test('relocated CODEX_HOME sessions are labelled Codex CLI by both detectors', () => {
	const home = path.join(CUSTOM_ROOT, 'openai');
	withAgentHomes({ CODEX_HOME: home }, () => {
		assertBothDetectors(path.join(home, 'sessions', '2026', '09', '01', 'rollout-2026-09-01T10-00-00-abc.jsonl'), 'Codex CLI');
		assertBothDetectors(path.join(home, 'archived_sessions', '2026', '09', '01', 'rollout-2026-09-01T10-00-00-abc.jsonl'), 'Codex CLI');
		assertBothDetectors(`${path.join(home, 'state_5.sqlite')}#thread-1`, 'Codex CLI');
		// Unrelated files under the relocated root are not claimed.
		assert.equal(getEditorSourceFromPath(path.join(home, 'config.toml')), 'VS Code');
		// Only <home>/state_<N>.sqlite#<id> is a thread path, not any state_* entry.
		assert.equal(getEditorSourceFromPath(`${path.join(home, 'state_x', 'other.sqlite')}#t`), 'VS Code');
		assert.equal(getEditorSourceFromPath(`${path.join(home, 'nested', 'state_5.sqlite')}#t`), 'VS Code');
	});
});

test('relative CODEX_HOME / HERMES_HOME match the paths their adapters build', () => {
	// Both adapters use a relative home verbatim (no resolve against cwd); the
	// detectors must compare against those same relative paths.
	withAgentHomes({ CODEX_HOME: 'agent-data/codex', HERMES_HOME: './agent-data/hermes-state' }, () => {
		const codex = new CodexCliDataAccess();
		assertBothDetectors(path.join(codex.getSessionsDir(), '2026', '09', '01', 'rollout-2026-09-01T10-00-00-abc.jsonl'), 'Codex CLI');
		assertBothDetectors(`${path.join(codex.getCodexHome(), 'state_5.sqlite')}#thread-1`, 'Codex CLI');
		const hermes = new HermesDataAccess();
		const virtualPath = hermes.virtualPath('20260726_204744_427b88');
		assertBothDetectors(virtualPath, 'Hermes');
		assert.equal(hermes.isHermesSessionFile(virtualPath), true);
	});
});

for (const home of ['.', '/']) {
	test(`CODEX_HOME / HERMES_HOME / VIBE_HOME of '${home}' match the paths their adapters build`, () => {
		// path.join drops a leading './' and does not double a root '/', so prefixes built
		// by string concatenation would miss these adapter-built paths.
		withAgentHomes({ CODEX_HOME: home, HERMES_HOME: home, VIBE_HOME: home }, () => {
			const codex = new CodexCliDataAccess();
			const rollout = path.join(codex.getSessionsDir(), '2026', '09', '01', 'rollout-2026-09-01T10-00-00-abc.jsonl');
			const thread = `${path.join(codex.getCodexHome(), 'state_5.sqlite')}#thread-1`;
			for (const p of [rollout, thread]) {
				assertBothDetectors(p, 'Codex CLI');
				assert.equal(codex.isCodexCliSessionFile(p), true, `Codex handles ${p}`);
			}
			// The thread path must also route to the SQLite DB, not the rollout-JSONL path.
			assert.equal(codex.isVirtualThreadPath(thread), true, `thread path ${thread}`);
			assert.equal(codex.getBackingPath(thread), path.join(codex.getCodexHome(), 'state_5.sqlite'));
			assert.equal(codex.getThreadId(thread), 'thread-1');
			assert.equal(codex.isVirtualThreadPath(rollout), false);
			// A rollout-named file outside sessions/ or archived_sessions/ is not Codex's.
			const stray = path.join(codex.getCodexHome(), 'project', 'rollout-not-codex.jsonl');
			assert.equal(codex.isCodexCliSessionFile(stray), false, `Codex must not handle ${stray}`);
			assert.notEqual(getEditorSourceFromPath(stray), 'Codex CLI');
			const hermes = new HermesDataAccess();
			const virtualPath = hermes.virtualPath('20260726_204744_427b88');
			assertBothDetectors(virtualPath, 'Hermes');
			assert.equal(hermes.isHermesSessionFile(virtualPath), true);
			const vibe = new MistralVibeDataAccess();
			const metaJson = path.join(vibe.getSessionLogDir(), 'session_20260901_100000_abcd1234', 'meta.json');
			assertBothDetectors(metaJson, 'Mistral Vibe');
			assert.equal(vibe.isVibeSessionFile(metaJson), true);
		});
	});
}

test('relocated VIBE_HOME sessions are labelled and handled as Mistral Vibe', () => {
	const home = path.join(CUSTOM_ROOT, 'mistral');
	const metaJson = path.join(home, 'logs', 'session', 'session_20260901_100000_abcd1234', 'meta.json');
	withAgentHomes({ VIBE_HOME: home }, () => {
		assertBothDetectors(metaJson, 'Mistral Vibe');
		const vibe = new MistralVibeDataAccess();
		assert.equal(vibe.isVibeSessionFile(metaJson), true, 'relocated meta.json must be handled');
		assert.equal(vibe.isVibeSessionFile(path.join(home, 'logs', 'session', 'x', 'messages.jsonl')), false);
	});
	withAgentHomes({}, () => {
		// Without VIBE_HOME the relocated path is neither labelled nor handled.
		assert.notEqual(getEditorSourceFromPath(metaJson), 'Mistral Vibe');
		assert.equal(new MistralVibeDataAccess().isVibeSessionFile(metaJson), false);
		// The default location keeps working.
		assert.equal(new MistralVibeDataAccess().isVibeSessionFile('/home/u/.vibe/logs/session/s/meta.json'), true);
	});
});

test('relocated HERMES_HOME sessions are labelled and handled as Hermes', () => {
	const home = path.join(CUSTOM_ROOT, 'agent');
	const virtualPath = `${path.join(home, 'state.db')}#20260726_204744_427b88`;
	withAgentHomes({ HERMES_HOME: home }, () => {
		assertBothDetectors(virtualPath, 'Hermes');
		const hermes = new HermesDataAccess();
		assert.equal(hermes.isHermesSessionFile(virtualPath), true, 'relocated virtual path must be handled');
		assert.equal(hermes.getSessionId(virtualPath), '20260726_204744_427b88');
		// A different state.db outside HERMES_HOME is not claimed.
		assert.equal(hermes.isHermesSessionFile(`${path.join(CUSTOM_ROOT, 'other', 'state.db')}#x`), false);
	});
	withAgentHomes({}, () => {
		assert.notEqual(getEditorSourceFromPath(virtualPath), 'Hermes');
	});
});
