import test from 'node:test';
import * as assert from 'node:assert/strict';
import { determineOnboardingAction } from '../../src/onboarding';

test('determineOnboardingAction', async (t) => {

	await t.test('returning user (hasSeenOnboarding=true) always returns none', () => {
		assert.strictEqual(determineOnboardingAction(true, 0, false), 'none');
		assert.strictEqual(determineOnboardingAction(true, 0, true), 'none');
		assert.strictEqual(determineOnboardingAction(true, 5, false), 'none');
		assert.strictEqual(determineOnboardingAction(true, 5, true), 'none');
	});

	await t.test('first run with data found returns none', () => {
		assert.strictEqual(determineOnboardingAction(false, 1, false), 'none');
		assert.strictEqual(determineOnboardingAction(false, 10, false), 'none');
		// Even with a discovery error, files found means proceed normally
		assert.strictEqual(determineOnboardingAction(false, 1, true), 'none');
	});

	await t.test('genuine first use (no files, no error) returns welcome', () => {
		assert.strictEqual(determineOnboardingAction(false, 0, false), 'welcome');
	});

	await t.test('discovery failure (no files, had error) returns diagnostics', () => {
		assert.strictEqual(determineOnboardingAction(false, 0, true), 'diagnostics');
	});
});
