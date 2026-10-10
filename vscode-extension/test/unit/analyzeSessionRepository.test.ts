import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import tokenEstimatorsData from '../../../src/tokenEstimators.json';
import modelPricingData from '../../../src/modelPricing.json';
import toolNamesData from '../../../src/toolNames.json';
import type { ModelPricing, TokenEstimator } from '../../../src/types';
import { analyzeSessionFile, type SessionAnalyzerDeps } from '../../src/analysis/sessionFileAnalyzer';

// The normal (worker) analysis resolves a session's git remote, so workspace grouping has its
// strongest signal on a cold cache too — not only after the Details view populated the cache.

const deps: SessionAnalyzerDeps = {
	warn: () => undefined,
	ecosystems: [],
	tokenEstimators: tokenEstimatorsData.estimators as Record<string, TokenEstimator>,
	modelPricing: modelPricingData.pricing as { [key: string]: ModelPricing },
	toolNameMap: toolNamesData as { [key: string]: string },
};

function session(refs: string[]): string {
	return JSON.stringify({
		version: 3,
		requests: [{
			requestId: 'r1', timestamp: Date.now(), message: { text: 'hello' }, response: [{ value: 'hi' }],
			contentReferences: refs.map(fsPath => ({ kind: 'reference', reference: { fsPath } })),
		}],
	});
}

async function analyze(file: string, existing?: { repository?: string }) {
	const stat = fs.statSync(file);
	return analyzeSessionFile(deps, file, stat.mtimeMs, stat.size, existing);
}

test('analyzeSessionFile records the remote of the files a VS Code session referenced', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-repo-'));
	try {
		const repo = path.join(root, 'widget');
		fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
		fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n');
		const touched = path.join(repo, 'index.ts');
		fs.writeFileSync(touched, '');

		const withRef = path.join(root, 'with-ref.json');
		fs.writeFileSync(withRef, session([touched]));
		const found = await analyze(withRef);
		assert.equal(found.repository, 'https://github.com/acme/widget.git');
		assert.equal(found.repositoryResolved, true, 'Details can reuse the entry without re-parsing for a repository');

		// None found is stored as '' and still counts as resolved …
		const withoutRef = path.join(root, 'without-ref.json');
		fs.writeFileSync(withoutRef, session([]));
		const none = await analyze(withoutRef);
		assert.equal(none.repository, '');
		assert.equal(none.repositoryResolved, true);

		// … a previously found remote is carried forward …
		assert.equal((await analyze(withRef, { repository: 'https://github.com/kept/as-is' })).repository, 'https://github.com/kept/as-is');
		// … but a previous '' is not: the file changed (that is why it is re-analysed), and a
		// session that now references files gets its remote.
		assert.equal((await analyze(withRef, { repository: '' })).repository, 'https://github.com/acme/widget.git');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('analyzeSessionFile scopes the remote to the session\'s workspace folder (workspaceStorage)', async () => {
	// Long-form path: the workspace folder resolved from workspace.json goes through realpath,
	// and a Windows runner's temp dir can be an 8.3 short path (RUNNER~1), so build fixtures on the real path.
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-repo-')));
	try {
		const makeRepo = (name: string) => {
			const repo = path.join(root, name);
			fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
			fs.writeFileSync(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/acme/${name}.git\n`);
			const file = path.join(repo, 'index.ts');
			fs.writeFileSync(file, '');
			return { repo, file };
		};
		const app = makeRepo('app');
		const lib = makeRepo('lib');
		// A VS Code session whose workspace (workspace.json) is repo "app".
		const hashDir = path.join(root, 'workspaceStorage', 'abc123');
		fs.mkdirSync(path.join(hashDir, 'chatSessions'), { recursive: true });
		fs.writeFileSync(path.join(hashDir, 'workspace.json'), JSON.stringify({ folder: 'file:///' + app.repo.replace(/\\/g, '/') }));
		const sessionFile = path.join(hashDir, 'chatSessions', 's1.json');

		// It first looked at repo "lib", then at its own repo: the remote is still "app".
		fs.writeFileSync(sessionFile, session([lib.file, app.file]));
		assert.equal((await analyze(sessionFile)).repository, 'https://github.com/acme/app.git');

		// Only an outside reference: still the workspace's own remote, never "lib".
		fs.writeFileSync(sessionFile, session([lib.file]));
		assert.equal((await analyze(sessionFile)).repository, 'https://github.com/acme/app.git');

		// A workspace folder in no repository: none found ('') rather than a referenced repository.
		const loose = path.join(root, 'loose');
		fs.mkdirSync(loose);
		fs.writeFileSync(path.join(hashDir, 'workspace.json'), JSON.stringify({ folder: 'file:///' + loose.replace(/\\/g, '/') }));
		fs.writeFileSync(sessionFile, session([lib.file]));
		const none = await analyze(sessionFile);
		assert.equal(none.repository, '');
		assert.equal(none.repositoryResolved, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
