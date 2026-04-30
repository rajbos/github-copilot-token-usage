/**
 * Onboarding / empty-state logic for first-run guidance.
 *
 * Kept as a pure function so it can be unit-tested with a mocked extension context
 * without pulling in the full extension module.
 */

export type OnboardingAction = 'none' | 'welcome' | 'diagnostics';

/**
 * Determines what onboarding action to take after the initial session scan.
 *
 * @param hasSeenOnboarding  Whether `globalState.get('hasSeenOnboarding')` is true.
 *                           A returning user whose workspace storage was wiped should
 *                           never see the welcome flow again.
 * @param sessionFilesCount  Number of session files discovered in the last scan.
 * @param hadDiscoveryError  Whether any adapter threw an error during discovery.
 */
export function determineOnboardingAction(
	hasSeenOnboarding: boolean,
	sessionFilesCount: number,
	hadDiscoveryError: boolean,
): OnboardingAction {
	// Returning user: never show welcome again even if workspace storage was wiped.
	if (hasSeenOnboarding) { return 'none'; }

	// Files found on first run — proceed normally; caller should mark hasSeenOnboarding.
	if (sessionFilesCount > 0) { return 'none'; }

	// No files and adapter(s) threw an error: route to Diagnostics.
	if (hadDiscoveryError) { return 'diagnostics'; }

	// No files, no errors: genuine first use — show welcome notification.
	return 'welcome';
}
