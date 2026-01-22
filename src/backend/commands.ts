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

/**
 * Handles backend-related commands.
 */
export class BackendCommandHandler {
	private facade: BackendFacadeInterface;
	private displayNameStore: DisplayNameStore | undefined;
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
			showBackendError(
				`Configuration wizard failed: ${error instanceof Error ? error.message : String(error)}`
			);
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
			showBackendError(
				`Failed to toggle workspace/machine name sync: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	async setSharingProfile(): Promise<void> {
		return this.handleSetSharingProfile();
	}

	async handleSetSharingProfile(): Promise<void> {
		try {
			await this.facade.setSharingProfileCommand();
		} catch (error) {
			showBackendError(
				`Failed to set sharing profile: ${error instanceof Error ? error.message : String(error)}`
			);
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
			showBackendSuccess('Manual sync completed successfully.');
		} catch (error) {
			showBackendError(
				`Manual sync failed: ${error instanceof Error ? error.message : String(error)}`
			);
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
			showBackendError(
				`Query failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Handles the "Set Backend Shared Key" command.
	 */
	async handleSetBackendSharedKey(): Promise<void> {
		try {
			await this.facade.setBackendSharedKey();
		} catch (error) {
			showBackendError(
				`Failed to set shared key: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Handles the "Rotate Backend Shared Key" command.
	 */
	async handleRotateBackendSharedKey(): Promise<void> {
		const confirmed = await confirmAction(
			'This will replace the current shared key with a new one. Make sure the new key is valid.',
			'Rotate Key'
		);
		if (!confirmed) {
			return;
		}

		try {
			await this.facade.rotateBackendSharedKey();
		} catch (error) {
			showBackendError(
				`Failed to rotate shared key: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Handles the "Clear Backend Shared Key" command.
	 */
	async handleClearBackendSharedKey(): Promise<void> {
		const confirmed = await confirmAction(
			'This will remove the stored shared key from this machine. You will need to re-enter it to sync.',
			'Clear Key'
		);
		if (!confirmed) {
			return;
		}

		try {
			await this.facade.clearBackendSharedKey();
		} catch (error) {
			showBackendError(
				`Failed to clear shared key: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Handles enabling team sharing (consent gate).
	 */
	async handleEnableTeamSharing(): Promise<void> {
		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		const consent = await vscode.window.showWarningMessage(
			'Enable team sharing to include a per-user identifier in backend rollups. Anyone with access to the shared dataset can see this identifier.',
			{ modal: true },
			'Enable'
		);
		if (consent !== 'Enable') {
			return;
		}

		const consentAt = new Date().toISOString();
		try {
			await config.update('backend.sharingProfile', 'teamPseudonymous', vscode.ConfigurationTarget.Global);
			await config.update('backend.shareWithTeam', true, vscode.ConfigurationTarget.Global);
			await config.update('backend.shareConsentAt', consentAt, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('Team sharing enabled. Future syncs will include your per-user identifier.');
		} catch (error) {
			showBackendError(
				`Failed to enable team sharing: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * Handles disabling team sharing (stop writing user identifiers).
	 */
	async handleDisableTeamSharing(): Promise<void> {
		const confirmed = await confirmAction(
			'Switch to anonymized sharing mode? This will hash workspace/machine IDs and remove per-user identifiers and names.',
			'Disable Team Sharing'
		);
		if (!confirmed) {
			return;
		}

		const config = vscode.workspace.getConfiguration('copilotTokenTracker');
		try {
			await config.update('backend.sharingProfile', 'teamAnonymized', vscode.ConfigurationTarget.Global);
			await config.update('backend.shareWithTeam', false, vscode.ConfigurationTarget.Global);
			await config.update('backend.shareWorkspaceMachineNames', false, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('Team sharing disabled. Future syncs will use hashed IDs with no per-user identifier or names.');
		} catch (error) {
			showBackendError(
				`Failed to disable team sharing: ${error instanceof Error ? error.message : String(error)}`
			);
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
				? 'Exported with identifiers/names to clipboard as JSON.'
				: 'Redacted query results exported to clipboard as JSON.');
		} catch (error) {
			showBackendError(
				`Failed to export: ${error instanceof Error ? error.message : String(error)}`
			);
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
