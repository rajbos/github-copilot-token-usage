/**
 * Command handlers for backend operations.
 * Provides VS Code command implementations for backend features.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import type { BackendFacade } from './facade';
import { copyBackendConfigToClipboard } from './copyConfig';
import { computeBackendSharingPolicy } from './sharingProfile';
import { showBackendError, showBackendSuccess, confirmAction } from './integration';
import type { DisplayNameStore } from './displayNames';
import { writeClipboardText } from '../utils/clipboard';
import type { BackendFacadeInterface } from './types';
import type { BackendSettings } from './settings';
import { ErrorMessages, SuccessMessages, ConfirmationMessages } from './ui/messages';

/**
 * Handles backend-related commands.
 */
export class BackendCommandHandler {
	private readonly facade: BackendFacadeInterface;
	private readonly displayNameStore: DisplayNameStore | undefined;
	private lastManualSyncAt = 0;
	private readonly MANUAL_SYNC_COOLDOWN_MS = 5000; // 5 seconds

	constructor(deps: {
		facade: BackendFacadeInterface;
		integration: unknown;
		calculateEstimatedCost: (mu: unknown) => number;
		warn: (m: string) => void;
		log: (m: string) => void;
		displayNameStore?: DisplayNameStore;
	}) {
		this.facade = deps.facade;
		this.displayNameStore = deps.displayNameStore;
		// Intentionally ignore unused deps for now (MVP): integration/cost/log hooks.
	}

	/**
	 * Handles the "Configure Backend" command.
	 * Launches the wizard to set up Azure resources.
	 */
	async handleConfigureBackend(): Promise<void> {
		try {
			await this.facade.configureBackendWizard();
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('configure backend', `Try the wizard again. Details: ${details}`));
		}
	}

	// Convenience methods matching the old interface
	async configureBackend(): Promise<void> {
		return this.handleConfigureBackend();
	}

	async copyBackendConfig(): Promise<void> {
		return this.handleCopyBackendConfig();
	}

	async exportCurrentView(): Promise<void> {
		return this.handleExportCurrentView();
	}

	async setBackendSharedKey(): Promise<void> {
		return this.handleSetBackendSharedKey();
	}

	async rotateBackendSharedKey(): Promise<void> {
		return this.handleRotateBackendSharedKey();
	}

	async clearBackendSharedKey(): Promise<void> {
		return this.handleClearBackendSharedKey();
	}

	async toggleBackendWorkspaceMachineNameSync(): Promise<void> {
		return this.handleToggleBackendWorkspaceMachineNameSync();
	}

	async enableTeamSharing(): Promise<void> {
		return this.handleEnableTeamSharing();
	}

	async disableTeamSharing(): Promise<void> {
		return this.handleDisableTeamSharing();
	}

	async handleToggleBackendWorkspaceMachineNameSync(): Promise<void> {
		try {
			await this.facade.toggleBackendWorkspaceMachineNameSync();
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('toggle workspace/machine name sync', `Check settings. Details: ${details}`));
		}
	}

	async setSharingProfile(): Promise<void> {
		return this.handleSetSharingProfile();
	}

	async clearAzureSettings(): Promise<void> {
		return this.handleClearAzureSettings();
	}

	async handleSetSharingProfile(): Promise<void> {
		try {
			await this.facade.setSharingProfileCommand();
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('set sharing profile', `Try again. Details: ${details}`));
		}
	}

	/**
	 * Handles the "Copy Backend Config" command.
	 * Copies configuration to clipboard without secrets.
	 */
	async handleCopyBackendConfig(): Promise<void> {
		const settings = this.facade.getSettings() as BackendSettings;
		await copyBackendConfigToClipboard(settings);
	}

	/**
	 * Handles the "Sync Backend Now" command.
	 * Triggers an immediate manual sync.
	 */
	async handleSyncBackendNow(): Promise<void> {
		const now = Date.now();
		if (now - this.lastManualSyncAt < this.MANUAL_SYNC_COOLDOWN_MS) {
			vscode.window.showWarningMessage('Please wait a few seconds before syncing again.');
			return;
		}
		this.lastManualSyncAt = now;

		const settings = this.facade.getSettings() as BackendSettings;
		if (!settings.enabled) {
			vscode.window.showWarningMessage(
				'Backend sync is disabled. Enable it in settings or run "Configure Backend" first.'
			);
			return;
		}

		if (!this.facade.isConfigured(settings)) {
			vscode.window.showWarningMessage(
				'Backend is not fully configured. Run "Configure Backend" to set up Azure resources.'
			);
			return;
		}

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Syncing to backend...',
					cancellable: false
				},
				async () => {
					await this.facade.syncToBackendStore(true);
				}
			);
			showBackendSuccess(SuccessMessages.synced());
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.sync(details));
		}
	}

	/**
	 * Handles the "Query Backend" command.
	 * Shows a simple query result in a message.
	 */
	async handleQueryBackend(): Promise<void> {
		const settings = this.facade.getSettings() as BackendSettings;
		if (!settings.enabled || !this.facade.isConfigured(settings)) {
			vscode.window.showWarningMessage('Backend is not configured or enabled.');
			return;
		}

		try {
			const result = await this.facade.tryGetBackendDetailedStatsForStatusBar(settings);
			if (!result) {
				vscode.window.showWarningMessage('No data available from backend.');
				return;
			}

			const summary = [
				'Backend Query Results:',
				`  Today: ${result.today?.tokens || 0} tokens`,
				`  Month: ${result.month?.tokens || 0} tokens`,
				`  Last Updated: ${result.lastUpdated || 'Unknown'}`
			].join('\n');

			vscode.window.showInformationMessage(summary);
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.query(`Details: ${details}`));
		}
	}

	/**
	 * Handles the "Set Backend Shared Key" command.
	 */
	async handleSetBackendSharedKey(): Promise<void> {
		try {
			await this.facade.setBackendSharedKey();
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('set shared key', `Verify the key is valid. Details: ${details}`));
		}
	}

	/**
	 * Handles the "Rotate Backend Shared Key" command.
	 */
	async handleRotateBackendSharedKey(): Promise<void> {
		const conf = ConfirmationMessages.rotateKey();
		const confirmed = await vscode.window.showWarningMessage(
			conf.message,
			{ modal: true, detail: conf.detail },
			conf.button
		);
		if (confirmed !== conf.button) {
			return;
		}

		try {
			await this.facade.rotateBackendSharedKey();
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('rotate shared key', `Verify the new key is valid. Details: ${details}`));
		}
	}

	/**
	 * Handles the "Clear Backend Shared Key" command.
	 */
	async handleClearBackendSharedKey(): Promise<void> {
		const conf = ConfirmationMessages.clearKey();
		const confirmed = await vscode.window.showWarningMessage(
			conf.message,
			{ modal: true, detail: conf.detail },
			conf.button
		);
		if (confirmed !== conf.button) {
			return;
		}

		try {
			await this.facade.clearBackendSharedKey();
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('clear shared key', `Try again. Details: ${details}`));
		}
	}

	/**
	 * Handles enabling team sharing (consent gate).
	 */
	async handleEnableTeamSharing(): Promise<void> {
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		const conf = ConfirmationMessages.enableTeamSharing();
		const consent = await vscode.window.showWarningMessage(
			conf.message,
			{ modal: true, detail: conf.detail },
			conf.button
		);
		if (consent !== conf.button) {
			return;
		}

		const consentAt = new Date().toISOString();
		try {
			await config.update('backend.sharingProfile', 'teamPseudonymous', vscode.ConfigurationTarget.Global);
			await config.update('backend.shareWithTeam', true, vscode.ConfigurationTarget.Global);
			await config.update('backend.shareConsentAt', consentAt, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(SuccessMessages.completed('Team sharing enabled'));
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('enable team sharing', `Check settings. Details: ${details}`));
		}
	}

	/**
	 * Handles disabling team sharing (stop writing user identifiers).
	 */
	async handleDisableTeamSharing(): Promise<void> {
		const conf = ConfirmationMessages.disableTeamSharing();
		const confirmed = await vscode.window.showWarningMessage(
			conf.message,
			{ modal: true, detail: conf.detail },
			conf.button
		);
		if (confirmed !== conf.button) {
			return;
		}

		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		try {
			await config.update('backend.sharingProfile', 'teamAnonymized', vscode.ConfigurationTarget.Global);
			await config.update('backend.shareWithTeam', false, vscode.ConfigurationTarget.Global);
			await config.update('backend.shareWorkspaceMachineNames', false, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(SuccessMessages.completed('Switched to anonymized sharing'));
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('disable team sharing', `Check settings. Details: ${details}`));
		}
	}

	/**
	 * Handles the "Clear Azure Settings" command.
	 */
	async handleClearAzureSettings(): Promise<void> {
		const conf = ConfirmationMessages.clearKey();
		const confirmed = await vscode.window.showWarningMessage(
			'Clear all Azure settings?',
			{ modal: true, detail: 'This will remove all Azure resource IDs, credentials, and backend configuration. You will need to reconfigure the backend to use it again.' },
			'Clear Settings'
		);
		if (confirmed !== 'Clear Settings') {
			return;
		}

		try {
			await this.facade.clearAzureSettingsCommand();
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('clear Azure settings', `Try again. Details: ${details}`));
		}
	}

	/**
	 * Handles the "Export Current View" command.
	 * Exports the current query result as JSON.
	 */
	async handleExportCurrentView(): Promise<void> {
		const result = this.facade.getLastQueryResult();
		if (!result) {
			vscode.window.showWarningMessage('No query results available to export.');
			return;
		}

		const settings = this.facade.getSettings?.() as BackendSettings | undefined;
		const policy = settings
			? computeBackendSharingPolicy({
				enabled: settings.enabled,
				profile: settings.sharingProfile,
				shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames
			})
			: undefined;
		const allowIdentifiers = !!policy && (policy.includeNames || policy.workspaceIdStrategy === 'raw' || policy.machineIdStrategy === 'raw');

		let includeIdentifiers = false;
		if (allowIdentifiers) {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: 'Redacted (recommended)', description: 'No workspace/machine IDs or names.', include: false },
					{ label: 'Include identifiers/names', description: 'May expose workspace/machine IDs and names.', include: true }
				],
				{ title: 'Export current view', placeHolder: 'Choose export strictness' }
			);
			if (!pick) {
				return;
			}
			includeIdentifiers = !!pick.include;
		} else if (policy) {
			vscode.window.showInformationMessage('Export will remain redacted based on the active Sharing Profile.');
		}

		try {
			const payload = redactBackendQueryResultForExport(result, { includeIdentifiers });
			const json = JSON.stringify(payload, null, 2);
			await writeClipboardText(json);
			vscode.window.showInformationMessage(includeIdentifiers
				? SuccessMessages.exported('Query results with identifiers')
				: SuccessMessages.exported('Redacted query results'));
		} catch (error) {
			const details = error instanceof Error ? error.message : String(error);
			showBackendError(ErrorMessages.unable('export results', `Try again. Details: ${details}`));
		}
	}
}

function redactBackendQueryResultForExport(result: any, opts?: { includeIdentifiers?: boolean }): any {
	if (!result || typeof result !== 'object') {
		return result;
	}
	try {
			const cloned = JSON.parse(JSON.stringify(result));
		const includeIdentifiers = !!opts?.includeIdentifiers;

		if (!includeIdentifiers) {
			delete cloned.workspaceNamesById;
			delete cloned.machineNamesById;
			cloned.availableWorkspaces = [];
			cloned.availableMachines = [];
			cloned.availableUsers = [];
			cloned.workspaceTokenTotals = [];
			cloned.machineTokenTotals = [];
		}

		return cloned;
	} catch (e) {
		// Fall back to returning original result if cloning fails (e.g., circular references)
		return result;
	}
}
