import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { CLI_LOCALE_BUNDLES, createTranslator, resolvedLocale } from '../l10n';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('the CLI binds every shipped package.nls.<locale>.json bundle', () => {
	const shipped = fs.readdirSync(path.join(REPO_ROOT, 'vscode-extension'))
		.map(f => /^package\.nls\.(.+)\.json$/.exec(f)?.[1]?.toLowerCase())
		.filter((id): id is string => !!id)
		.sort();
	assert.deepEqual(Object.keys(CLI_LOCALE_BUNDLES).sort(), shipped);
});

test('the CLI translator resolves real shipped strings', () => {
	const key = 'insight.missingInstructions.title';
	const bundle = (file: string) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vscode-extension', file), 'utf8'));
	assert.equal(createTranslator('en')(key), bundle('package.nls.json')[key]);
	assert.equal(createTranslator('zh-CN')(key), bundle('package.nls.zh-cn.json')[key] ?? bundle('package.nls.json')[key]);
	assert.equal(resolvedLocale('zh-CN'), 'zh-cn');
	assert.equal(resolvedLocale('fr-FR'), 'en');
});

test('CLI production code imports no VS Code extension source', () => {
	const offenders: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'test') { walk(full); }
			} else if (entry.name.endsWith('.ts')) {
				const text = fs.readFileSync(full, 'utf8');
				if (/from\s+['"][^'"]*vscode-extension\/src\//.test(text)) { offenders.push(path.relative(REPO_ROOT, full)); }
			}
		}
	};
	walk(path.join(REPO_ROOT, 'cli', 'src'));
	assert.deepEqual(offenders, []);
});
