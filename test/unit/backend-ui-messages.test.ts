/**
 * Unit tests for UI message helpers.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ValidationMessages, ErrorMessages, SuccessMessages, HelpText, ConfirmationMessages } from '../backend/ui/messages';

describe('ValidationMessages', () => {
	it('should generate required field message without example', () => {
		const msg = ValidationMessages.required('Dataset ID');
		assert.equal(msg, 'Dataset ID is required.');
	});

	it('should generate required field message with example', () => {
		const msg = ValidationMessages.required('Dataset ID', '"my-team"');
		assert.equal(msg, 'Dataset ID is required. Example: "my-team"');
	});

	it('should generate range validation message', () => {
		const msg = ValidationMessages.range('Lookback days', 1, 90, 'days');
		assert.equal(msg, 'Must be between 1 and 90 days.');
	});

	it('should generate range validation message without unit', () => {
		const msg = ValidationMessages.range('Count', 1, 100);
		assert.equal(msg, 'Must be between 1 and 100.');
	});

	it('should generate format validation message', () => {
		const msg = ValidationMessages.format('Team alias', 'use only lowercase letters and dashes', 'alex-dev');
		assert.equal(msg, 'Team alias must use only lowercase letters and dashes. Example: alex-dev');
	});

	it('should generate GUID format validation message', () => {
		const msg = ValidationMessages.guidFormat('Object ID');
		assert.equal(msg, 'Object ID must be a valid unique identifier (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');
	});

	it('should generate alphanumeric validation message', () => {
		const msg = ValidationMessages.alphanumeric('Dataset ID', 'my-team-copilot');
		assert.equal(msg, 'Dataset ID must use only letters, numbers, dashes, or underscores. Example: my-team-copilot');
	});

	it('should generate PII warning message', () => {
		const msg = ValidationMessages.piiWarning('Do not use email addresses or real names.');
		assert.equal(msg, '⚠ Do not use email addresses or real names.');
	});
});

describe('ErrorMessages', () => {
	it('should generate unable message with suggestion', () => {
		const msg = ErrorMessages.unable('save settings', 'Ensure all required fields are filled.');
		assert.equal(msg, 'Unable to save settings. Ensure all required fields are filled.');
	});

	it('should generate connection error without details', () => {
		const msg = ErrorMessages.connection();
		assert.equal(msg, 'Unable to connect. Check your network connection and try again.');
	});

	it('should generate connection error with details', () => {
		const msg = ErrorMessages.connection('Network timeout occurred.');
		assert.equal(msg, 'Unable to connect to Azure. Network timeout occurred. Check your network connection and try again.');
	});

	it('should generate auth error', () => {
		const msg = ErrorMessages.auth('Invalid credentials.');
		assert.equal(msg, 'Unable to authenticate. Invalid credentials. Verify your credentials and permissions.');
	});

	it('should generate sync error', () => {
		const msg = ErrorMessages.sync('Table not found.');
		assert.equal(msg, 'Unable to sync to Azure. Table not found. Check your Azure configuration and try again.');
	});

	it('should generate config error', () => {
		const msg = ErrorMessages.config('Dataset ID is required.');
		assert.equal(msg, 'Unable to save settings. Dataset ID is required.');
	});

	it('should generate query error with default suggestion', () => {
		const msg = ErrorMessages.query();
		assert.equal(msg, 'Unable to query backend data. Check your connection and auth settings.');
	});

	it('should generate query error with custom suggestion', () => {
		const msg = ErrorMessages.query('Verify table permissions.');
		assert.equal(msg, 'Unable to query backend data. Verify table permissions.');
	});
});

describe('SuccessMessages', () => {
	it('should generate saved message without specific item', () => {
		const msg = SuccessMessages.saved();
		assert.equal(msg, 'Settings saved successfully');
	});

	it('should generate saved message with specific item', () => {
		const msg = SuccessMessages.saved('Configuration');
		assert.equal(msg, 'Configuration saved successfully');
	});

	it('should generate synced message', () => {
		const msg = SuccessMessages.synced();
		assert.equal(msg, 'Synced to Azure successfully');
	});

	it('should generate configured message', () => {
		const msg = SuccessMessages.configured();
		assert.equal(msg, 'Backend configured successfully');
	});

	it('should generate exported message', () => {
		const msg = SuccessMessages.exported('Query results');
		assert.equal(msg, 'Query results exported successfully');
	});

	it('should generate connected message', () => {
		const msg = SuccessMessages.connected();
		assert.equal(msg, 'Connected to Azure Storage successfully');
	});

	it('should generate completed message', () => {
		const msg = SuccessMessages.completed('Manual sync');
		assert.equal(msg, 'Manual sync completed successfully');
	});

	it('should generate key updated message', () => {
		const msg = SuccessMessages.keyUpdated('mystorageaccount');
		assert.equal(msg, 'Shared key saved for mystorageaccount');
	});

	it('should be under 5 words for core messages', () => {
		const messages = [
			SuccessMessages.saved(),
			SuccessMessages.synced(),
			SuccessMessages.configured()
		];

		messages.forEach(msg => {
			const wordCount = msg.split(/\s+/).length;
			assert.ok(wordCount <= 5, `Message "${msg}" has ${wordCount} words, should be ≤5`);
		});
	});
});

describe('HelpText', () => {
	it('should generate dataset ID help text', () => {
		const help = HelpText.datasetId();
		assert.ok(help.includes('Dataset ID groups your usage data'));
		assert.ok(help.includes('Examples:'));
	});

	it('should generate lookback days help text', () => {
		const help = HelpText.lookbackDays();
		assert.ok(help.includes('How far back to sync'));
		assert.ok(help.includes('7 days'));
		assert.ok(help.includes('Smaller values sync faster'));
	});

	it('should generate sharing profiles help text', () => {
		const help = HelpText.sharingProfiles();
		assert.ok(help.includes('Off'));
		assert.ok(help.includes('Solo'));
		assert.ok(help.includes('Team Anonymized'));
		assert.ok(help.includes('Team Pseudonymous'));
		assert.ok(help.includes('Team Identified'));
	});

	it('should generate readable names help text for enabled state', () => {
		const help = HelpText.readableNames(true);
		assert.ok(help.includes('readable names'));
		assert.ok(help.includes('Team members'));
	});

	it('should generate readable names help text for disabled state', () => {
		const help = HelpText.readableNames(false);
		assert.ok(help.includes('hashed identifiers'));
		assert.ok(help.includes('privacy'));
	});

	it('should generate machine breakdown help text', () => {
		const help = HelpText.machineBreakdown();
		assert.ok(help.includes('per-machine'));
		assert.ok(help.includes('workspace totals'));
	});

	it('should generate Azure resources help text', () => {
		const help = HelpText.azureResources();
		assert.ok(help.includes('Azure Storage connection details'));
		assert.ok(help.includes('guided wizard'));
	});

	it('should generate auth mode help text for Entra ID', () => {
		const help = HelpText.authMode('entraId');
		assert.ok(help.includes('signed-in identity'));
		assert.ok(help.includes('role-based access'));
	});

	it('should generate auth mode help text for Shared Key', () => {
		const help = HelpText.authMode('sharedKey');
		assert.ok(help.includes('Storage Account Shared Key'));
		assert.ok(help.includes('Stored securely'));
	});

	it('should generate backend overview help text', () => {
		const help = HelpText.backendOverview();
		assert.ok(help.includes('Enable backend'));
		assert.ok(help.includes('Stay Local'));
	});

	it('should generate test connection help text', () => {
		const help = HelpText.testConnection();
		assert.ok(help.includes('Verifies'));
		assert.ok(help.includes('credentials'));
	});

	it('should generate team alias help text', () => {
		const help = HelpText.teamAlias();
		assert.ok(help.includes('non-identifying'));
		assert.ok(help.includes('Do not use email'));
	});

	it('should generate Entra object ID help text', () => {
		const help = HelpText.entraObjectId();
		assert.ok(help.includes('Entra ID object ID'));
		assert.ok(help.includes('Azure Portal'));
	});
});

describe('ConfirmationMessages', () => {
	it('should generate rotate key confirmation', () => {
		const conf = ConfirmationMessages.rotateKey();
		assert.equal(conf.message, 'Replace stored shared key?');
		assert.ok(conf.detail.includes('new key'));
		assert.equal(conf.button, 'Replace Key');
	});

	it('should generate clear key confirmation', () => {
		const conf = ConfirmationMessages.clearKey();
		assert.equal(conf.message, 'Remove stored shared key?');
		assert.ok(conf.detail.includes('re-enter'));
		assert.equal(conf.button, 'Remove Key');
	});

	it('should generate enable team sharing confirmation', () => {
		const conf = ConfirmationMessages.enableTeamSharing();
		assert.equal(conf.message, 'Share usage data with team?');
		assert.ok(conf.detail.includes('Team members'));
		assert.equal(conf.button, 'I Understand, Continue');
	});

	it('should generate disable team sharing confirmation', () => {
		const conf = ConfirmationMessages.disableTeamSharing();
		assert.equal(conf.message, 'Switch to anonymized sharing?');
		assert.ok(conf.detail.includes('hashed'));
		assert.equal(conf.button, 'Switch to Anonymized');
	});

	it('should generate privacy upgrade confirmation', () => {
		const reasons = ['include workspace names', 'add user identifier'];
		const conf = ConfirmationMessages.privacyUpgrade(reasons);
		assert.equal(conf.message, 'Confirm Privacy Changes');
		assert.ok(conf.detail.includes('include workspace names and add user identifier'));
		assert.equal(conf.button, 'I Understand, Continue');
	});

	it('should handle empty reasons array', () => {
		const conf = ConfirmationMessages.privacyUpgrade([]);
		assert.ok(conf.detail.includes('sharing settings are changing'));
	});
});
