/**
 * Regression guard: the diagnostic report used to print the "Session File Locations (first 20)"
 * block twice (once under Session Files Discovery, again under Token Usage Statistics), and the
 * webview's strip regex lacked the `g` flag so only the first copy was removed from the Report tab.
 *
 * Instantiating `CopilotTokenTracker` needs a full VS Code host, so this asserts structural
 * invariants on the source, like retryRefreshFlow.test.ts.
 */
import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractBracesBlock } from './sourceStructureTestHelpers';

const SRC_ROOT = path.join(__dirname, '../../../../src');
const EXTENSION_SRC = fs.readFileSync(path.join(SRC_ROOT, 'extension.ts'), 'utf8');
const DIAGNOSTICS_WEBVIEW_SRC = fs.readFileSync(path.join(SRC_ROOT, 'webview/diagnostics/main.ts'), 'utf8');

test('the session-file listing is emitted by exactly one report section', () => {
	const sessionFiles = extractBracesBlock(EXTENSION_SRC, 'private async buildDiagReportSessionFiles(report: string[]): Promise<void> {');
	const tokenStats = extractBracesBlock(EXTENSION_SRC, 'private async buildDiagReportTokenStats(report: string[]): Promise<void> {');
	assert.ok(sessionFiles.includes('appendSessionFileListing('), 'Session Files Discovery owns the listing');
	assert.ok(!tokenStats.includes('appendSessionFileListing('), 'Token Usage Statistics must not repeat the listing');
	assert.ok(!tokenStats.includes('appendNoSessionFilesMessage('), 'Token Usage Statistics must not repeat the no-files help');
});

test('only generateDiagnosticReport sections call appendSessionFileListing once in total', () => {
	const callSites = EXTENSION_SRC.match(/this\.appendSessionFileListing\(/g) ?? [];
	assert.equal(callSites.length, 1);
});

test('the webview strip regex is global so every listing block is removed', () => {
	const match = DIAGNOSTICS_WEBVIEW_SRC.match(/SESSION_FILES_SECTION_REGEX\s*=\s*\n?\s*(\/.*\/)([a-z]*);/);
	assert.ok(match, 'SESSION_FILES_SECTION_REGEX not found');
	assert.ok(match[2].includes('g'), 'regex needs the g flag');
	const re = new RegExp(match[1].slice(1, -1), match[2]);
	const text = 'A\nSession File Locations (first 20):\n  1. x\n\nB\nSession File Locations (first 20):\n  1. y\n\nC';
	const stripped = text.replace(re, '');
	assert.ok(!stripped.includes('Session File Locations'));
	assert.ok(stripped.includes('B') && stripped.includes('C'));
});
