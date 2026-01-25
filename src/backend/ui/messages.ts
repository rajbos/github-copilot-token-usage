/**
 * UI message helpers for backend features.
 * Provides consistent, user-friendly messages following the quick-reference.md patterns.
 */

/**
 * Validation message helpers.
 * Pattern: "[What's wrong]. [How to fix]. [Example if helpful]"
 */
export const ValidationMessages = {
	/**
	 * Generic required field message.
	 */
	required: (fieldName: string, example?: string): string => {
		const base = `${fieldName} is required`;
		return example ? `${base}. Example: ${example}` : `${base}.`;
	},

	/**
	 * Numeric range validation message.
	 */
	range: (fieldName: string, min: number, max: number, unit?: string): string => {
		const unitStr = unit ? ` ${unit}` : '';
		return `Must be between ${min} and ${max}${unitStr}.`;
	},

	/**
	 * Format/pattern validation message.
	 */
	format: (fieldName: string, requirements: string, example?: string): string => {
		const base = `${fieldName} must ${requirements}`;
		return example ? `${base}. Example: ${example}` : `${base}.`;
	},

	/**
	 * GUID/UUID format validation.
	 */
	guidFormat: (fieldName: string): string => {
		return `${fieldName} must be a valid unique identifier (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).`;
	},

	/**
	 * Character set validation for names/IDs.
	 */
	alphanumeric: (fieldName: string, example?: string): string => {
		const base = `${fieldName} must use only letters, numbers, dashes, or underscores`;
		return example ? `${base}. Example: ${example}` : `${base}.`;
	},

	/**
	 * Privacy/PII warning message.
	 */
	piiWarning: (message: string): string => {
		return `⚠ ${message}`;
	}
};

/**
 * Error message helpers.
 * Pattern: "Unable to [action]. [suggestion]."
 */
export const ErrorMessages = {
	/**
	 * Generic action failure with suggestion.
	 */
	unable: (action: string, suggestion: string): string => {
		return `Unable to ${action}. ${suggestion}`;
	},

	/**
	 * Connection failure message.
	 */
	connection: (details?: string): string => {
		const suggestion = 'Check your network connection and try again.';
		return details ? `Unable to connect to Azure. ${details} ${suggestion}` : `Unable to connect. ${suggestion}`;
	},

	/**
	 * Authentication failure message.
	 */
	auth: (details?: string): string => {
		const suggestion = 'Verify your credentials and permissions.';
		return details ? `Unable to authenticate. ${details} ${suggestion}` : `Authentication failed. ${suggestion}`;
	},

	/**
	 * Sync operation failure message.
	 */
	sync: (details?: string): string => {
		const suggestion = 'Check your Azure configuration and try again.';
		return details ? `Unable to sync to Azure. ${details} ${suggestion}` : `Sync failed. ${suggestion}`;
	},

	/**
	 * Configuration validation failure.
	 */
	config: (details: string): string => {
		return `Unable to save settings. ${details}`;
	},

	/**
	 * Query operation failure.
	 */
	query: (suggestion?: string): string => {
		const defaultSuggestion = 'Check your connection and auth settings.';
		return `Unable to query backend data. ${suggestion || defaultSuggestion}`;
	}
};

/**
 * Success message helpers.
 * Pattern: "[Action] [status]" - Keep under 5 words.
 */
export const SuccessMessages = {
	/**
	 * Settings saved successfully.
	 */
	saved: (what?: string): string => {
		return what ? `${what} saved successfully` : 'Settings saved successfully';
	},

	/**
	 * Sync completed successfully.
	 */
	synced: (): string => {
		return 'Synced to Azure successfully';
	},

	/**
	 * Configuration completed.
	 */
	configured: (): string => {
		return 'Backend configured successfully';
	},

	/**
	 * Export completed.
	 */
	exported: (what: string): string => {
		return `${what} exported successfully`;
	},

	/**
	 * Connection test passed.
	 */
	connected: (): string => {
		return '✓ Connected to Azure Storage successfully';
	},

	/**
	 * Generic action completed.
	 */
	completed: (action: string): string => {
		return `${action} completed successfully`;
	},

	/**
	 * Key/secret updated.
	 */
	keyUpdated: (accountName: string): string => {
		return `Shared key saved for ${accountName}`;
	}
};

/**
 * Help text helpers.
 * Pattern: "[What it does]. [Example]" - One sentence + examples.
 */
export const HelpText = {
	/**
	 * Dataset ID field helper.
	 */
	datasetId: (): string => {
		return 'Dataset ID groups your usage data. Examples: "my-team", "project-alpha", "personal-usage"';
	},

	/**
	 * Lookback days field helper.
	 */
	lookbackDays: (): string => {
		return 'How far back to sync: 7 days = current week, 30 days = current month, 90 days = full quarter. Smaller values sync faster.';
	},

	/**
	 * Sharing profile overview helper (concise format).
	 */
	sharingProfiles: (): string => {
		return 'Off – All data stays local • Solo – Private cloud storage • Team Anonymized – Hashed IDs, no names • Team Pseudonymous – Stable alias • Team Identified – Full identifier';
	},

	/**
	 * Workspace/machine names helper.
	 */
	readableNames: (enabled: boolean): string => {
		if (enabled) {
			return 'Stores readable names like "frontend-monorepo" and "Surface-Laptop". Team members with storage access can see these names.';
		}
		return 'Stores hashed identifiers like "ws_a1b2c3" instead of names. Enhances privacy but makes debugging harder.';
	},

	/**
	 * Machine breakdown helper.
	 */
	machineBreakdown: (): string => {
		return 'Includes per-machine usage rows. Helps identify noisy machines. Disable to merge into workspace totals only.';
	},

	/**
	 * Azure resource IDs intro.
	 */
	azureResources: (): string => {
		return 'Azure Storage connection details. Use the guided wizard to auto-fill these fields.';
	},

	/**
	 * Auth mode helper.
	 */
	authMode: (mode: 'entraId' | 'sharedKey'): string => {
		if (mode === 'entraId') {
			return 'Uses your signed-in identity. Requires role-based access to the storage account. No secrets stored.';
		}
		return 'Uses Storage Account Shared Key. Stored securely in VS Code on this device only.';
	},

	/**
	 * Backend overview helper (simplified).
	 */
	backendOverview: (): string => {
		return 'Enable backend to sync token usage to Azure. Choose "Stay Local" to keep all data on this device only.';
	},

	/**
	 * Test connection helper.
	 */
	testConnection: (): string => {
		return 'Verifies your credentials can read and write to the configured storage tables.';
	},

	/**
	 * Team alias helper.
	 */
	teamAlias: (): string => {
		return 'Use a non-identifying handle like "alex-dev" or "team-frontend". Do not use email addresses or real names.';
	},

	/**
	 * Entra object ID helper.
	 */
	entraObjectId: (): string => {
		return 'Your Entra ID object ID for compliance-grade auditing. Find it in Azure Portal under your user profile.';
	}
};

/**
 * Confirmation dialog helpers.
 */
export const ConfirmationMessages = {
	/**
	 * Shared key rotation confirmation.
	 */
	rotateKey: (): { message: string; detail: string; button: string } => {
		return {
			message: 'Replace stored shared key?',
			detail: 'You will be prompted to enter the new key. Ensure the new key is valid before proceeding.',
			button: 'Replace Key'
		};
	},

	/**
	 * Shared key removal confirmation.
	 */
	clearKey: (): { message: string; detail: string; button: string } => {
		return {
			message: 'Remove stored shared key?',
			detail: 'You will need to re-enter the key to sync again.',
			button: 'Remove Key'
		};
	},

	/**
	 * Team sharing enablement confirmation.
	 */
	enableTeamSharing: (): { message: string; detail: string; button: string } => {
		return {
			message: 'Share usage data with team?',
			detail: 'Team members with storage access will see your usage stats. Workspace names will be included if enabled.',
			button: 'I Understand, Continue'
		};
	},

	/**
	 * Team sharing disablement confirmation.
	 */
	disableTeamSharing: (): { message: string; detail: string; button: string } => {
		return {
			message: 'Switch to anonymized sharing?',
			detail: 'Workspace and machine IDs will be hashed. Names and user identifiers will be removed from future syncs.',
			button: 'Switch to Anonymized'
		};
	},

	/**
	 * Privacy upgrade consent.
	 */
	privacyUpgrade: (reasons: string[]): { message: string; detail: string; button: string } => {
		const reasonsText = reasons.length > 0 ? reasons.join(' and ') : 'sharing settings are changing';
		return {
			message: 'Confirm Privacy Changes',
			detail: `This will ${reasonsText}. Continue?`,
			button: 'I Understand, Continue'
		};
	}
};
