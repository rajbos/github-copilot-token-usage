import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

// Lives with the extension's tests (not src/test): it reads the extension's own analyzer source.
test('wiring: the session analyzer feeds one resolved task attribution to the rollups and the entry', () => {
	// The per-day rollups used to read usageAnalysis.taskClassification directly, so an empty
	// placeholder still put "Conversation" on every day while the session entry carried the
	// tool-heuristic category, and the Chart's "By Task" disagreed with the CLI.
	const src = fs.readFileSync(path.join(__dirname, '../../../../src/analysis/sessionFileAnalyzer.ts'), 'utf8');
	assert.match(src, /const taskAttribution = resolveSessionTaskAttribution\(usageAnalysis, sessionMeta\.title\);/);
	assert.match(src, /computeDailyRollups\([^)]*taskAttribution\)/);
	assert.match(src, /buildSessionDataObject\([^)]*taskAttribution, resolution\)/);
	assert.doesNotMatch(src, /usageAnalysis\.taskClassification\?\.(primaryCategory|categoryShares)/, 'nothing may bypass the resolved attribution');
});
