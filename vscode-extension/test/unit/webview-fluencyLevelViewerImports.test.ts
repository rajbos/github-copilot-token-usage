import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Compiled tests live at <ext>/out/vscode-extension/test/unit, so four levels up is <ext>.
const SRC = readFileSync(join(__dirname, '../../../../src/webview/fluency-level-viewer/main.ts'), 'utf8');

/** Names imported from `../shared/formatUtils`. */
function formatUtilsImports(): string[] {
	const match = SRC.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/shared\/formatUtils'/);
	assert.ok(match, 'fluency-level-viewer/main.ts imports from ../shared/formatUtils');
	return match[1].split(',').map((name) => name.trim()).filter(Boolean);
}

test('fluency-level-viewer only imports the formatUtils helpers it uses', () => {
	const body = SRC.replace(/^import[^;]*;$/gm, '');
	for (const name of formatUtilsImports()) {
		assert.ok(new RegExp('\\b' + name + '\\b').test(body), `${name} is imported but never used`);
	}
});

test('fluency-level-viewer no longer imports STAGE_LABELS', () => {
	assert.ok(!formatUtilsImports().includes('STAGE_LABELS'));
});
