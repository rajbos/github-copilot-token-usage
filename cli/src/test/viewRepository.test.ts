/**
 * End to end, without fs mocks: a session that references files in a repository must land in
 * the Chart payload's "By Repository" data, as it does in the extension. The CLI used to record
 * every day as "Unknown", leaving that view empty in the CLI and the desktop app (#2316).
 *
 * The fixture lives under the build output (cli/out, git-ignored) rather than the OS temp dir,
 * and is removed afterwards. The on-disk CLI cache is never loaded or saved here.
 */
import test, { after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { calculateDailyStats } from '../helpers';
import { buildChartPayload } from '../analysis';

const REMOTE = 'https://github.com/octo/widgets.git';
const fixtureRoot = fs.mkdtempSync(path.join(__dirname, 'view-repo-'));
after(() => { fs.rmSync(fixtureRoot, { recursive: true, force: true }); });

test('a session referencing a repository fills the CLI chart payload\'s By Repository data', async () => {
	const repo = path.join(fixtureRoot, 'widgets');
	fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
	fs.writeFileSync(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = ${REMOTE}\n`);
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
	const source = path.join(repo, 'src', 'index.ts');
	fs.writeFileSync(source, 'export {};\n');

	const sessionDir = path.join(fixtureRoot, 'workspaceStorage', 'abc', 'chatSessions');
	fs.mkdirSync(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, '77777777-7777-4777-8777-777777777777.json');
	fs.writeFileSync(sessionFile, JSON.stringify({ requests: [{
		requestId: 'r1', timestamp: Date.now(), modelId: 'copilot/gpt-4o',
		message: { text: 'Fix the widget', parts: [{ text: 'Fix the widget' }] },
		response: [], result: { promptTokens: 400, outputTokens: 80 },
		contentReferences: [{ kind: 'reference', reference: { fsPath: source } }],
	}] }));

	const dailyStats = await calculateDailyStats([sessionFile]);
	assert.ok(dailyStats.some(d => d.repositoryUsage[REMOTE]?.tokens > 0), 'the session\'s tokens must be attributed to its repository');
	assert.ok(dailyStats.every(d => !d.repositoryUsage.Unknown), 'a resolved repository must not also be counted as Unknown');

	const payload = buildChartPayload(dailyStats);
	const datasets = payload.repositoryDatasets as Array<{ fullRepo: string; data: number[] }>;
	assert.deepEqual(datasets.map(d => d.fullRepo), [REMOTE]);
	assert.ok(datasets[0].data.some(v => v > 0));
});
