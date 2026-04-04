import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('Extension should be present', () => {
		const extension = vscode.extensions.getExtension('RobBos.copilot-token-tracker');
		assert.ok(extension, 'Extension should be installed');
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		
		const expectedCommands = [
			'copilot-token-tracker.refresh',
			'copilot-token-tracker.showDetails',
			'copilot-token-tracker.showChart',
			'copilot-token-tracker.showMaturity',
			'copilot-token-tracker.showFluencyLevelViewer',
			'copilot-token-tracker.generateDiagnosticReport'
		];

		for (const expectedCommand of expectedCommands) {
			assert.ok(
				commands.includes(expectedCommand),
				`Command ${expectedCommand} should be registered`
			);
		}
	});
});
