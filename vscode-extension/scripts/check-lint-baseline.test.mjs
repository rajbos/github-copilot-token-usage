#!/usr/bin/env node
/** Unit tests for check-lint-baseline.mjs. Run with: node --test scripts/check-lint-baseline.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarise, findRegressions } from './check-lint-baseline.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const abs = rel => path.join(repoRoot, ...rel.split('/'));

test('summarise: splits errors from per-rule per-file warning counts', () => {
	const { errors, counts } = summarise([
		{ filePath: abs('src/a.ts'), messages: [
			{ severity: 1, ruleId: 'complexity', line: 1, column: 1, message: 'm' },
			{ severity: 1, ruleId: 'complexity', line: 2, column: 1, message: 'm' },
			{ severity: 2, ruleId: 'max-lines', line: 3, column: 1, message: 'too long' },
		] },
	]);
	assert.deepEqual(counts, { complexity: { 'src/a.ts': 2 } });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /^src\/a\.ts:3:1 max-lines too long$/);
});

test('findRegressions: growth and new pairs fail, shrinkage passes', () => {
	const baseline = { complexity: { 'src/a.ts': 2 } };
	assert.deepEqual(findRegressions({ complexity: { 'src/a.ts': 1 } }, baseline), []);
	assert.deepEqual(findRegressions({ complexity: { 'src/a.ts': 2 } }, baseline), []);
	assert.equal(findRegressions({ complexity: { 'src/a.ts': 3 } }, baseline).length, 1);
	assert.equal(findRegressions({ complexity: { 'src/b.ts': 1 } }, baseline).length, 1);
	assert.equal(findRegressions({ 'max-depth': { 'src/a.ts': 1 } }, baseline).length, 1);
});
