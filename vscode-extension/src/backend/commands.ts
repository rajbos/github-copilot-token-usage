/**
 * Command handlers for backend operations.
 * Provides VS Code command implementations for backend features.
 */

import * as vscode from 'vscode';

import type { BackendFacade } from './facade';
import { copyBackendConfigToClipboard } from './copyConfig';
import { computeBackendSharingPolicy } from './sharingProfile';
import { showBackendError, showBackendSuccess } from './integration';
import type { DisplayNameStore } from './displayNames';
import { writeClipboardText } from '../utils/clipboard';
import type { BackendFacadeInterface, SyncResult } from './types';
import { resolveSyncTargets, type BackendSettings, type SyncTargets } from './settings';
import { ErrorMessages, SuccessMessages, ConfirmationMessages } from './ui/messages';
import { MANUAL_SYNC_COOLDOWN_MS } from './constants';
import { RateLimiter } from '../utils/rateLimiter';
import { t } from '../l10n';
import { applySettingsAtomically } from './settingsBatch';

/** Names the targets a manual sync writes to, for its progress, success and error text. */
function describeSyncTargets(targets: SyncTargets): string {
	if (targets.azure && targets.sharingServer) { return t('backend.syncNow.target.both'); }
	return targets.azure ? t('backend.syncNow.target.azure') : t('backend.syncNow.target.teamServer');
}

/** Which targets ended in each outcome; a field is undefined when no target did. */
interface PartitionedSyncResult {
	synced?: SyncTargets;
	skipped?: SyncTargets;
	failed?: SyncTargets;
}

/**
 * Splits a sync pass's per-target result by outcome so Sync Now can report each target honestly:
 * a partial result is never collapsed into "synced to both". A facade that reports no result is
 * treated as having synced every attempted target.
 */
function partitionSyncResult(result: SyncResult | void, attempted: SyncTargets): PartitionedSyncResult {
	if (!result) { return { synced: attempted }; }
	const pick = (outcome: 'synced' | 'skipped' | 'failed'): SyncTargets | undefined => {
		const targets = { azure: result.azure === outcome, sharingServer: result.sharingServer === outcome };
		return targets.azure || targets.sharingServer ? targets : undefined;
	};
	return { synced: pick('synced'), skipped: pick('skipped'), failed: pick('failed') };
}

async function withBackendErrorHandling(label: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		showBackendError(ErrorMessages.unable(label, `Try again. Details: ${details}`));
	}
}

/**
 * Handles backend-related commands.
 */
export class BackendCommandHandler {
	private readonly facade: BackendFacadeInterface;
	private readonly displayNameStore: DisplayNameStore | undefined;
	private readonly syncRateLimiter = new RateLimiter(MANUAL_SYNC_COOLDOWN_MS);

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
		await withBackendErrorHandling('configure backend', () => this.facade.configureBackendWizard());
	}

	/**
	 * Handles the "Toggle Workspace/Machine Name Sync" command.
	 */
	async handleToggleBackendWorkspaceMachineNameSync(): Promise<void> {
		await withBackendErrorHandling('toggle workspace/machine name sync', () => this.facade.toggleBackendWorkspaceMachineNameSync());
	}

	/**
	 * Handles the "Set Sharing Profile" command.
	 */
	async handleSetSharingProfile(): Promise<void> {
		await withBackendErrorHandling('set sharing profile', () => this.facade.setSharingProfileCommand());
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
		if (!this.syncRateLimiter.canExecute()) {
			vscode.window.showWarningMessage('Please wait a few seconds before syncing again.');
			return;
		}
		this.syncRateLimiter.recordExecution();

		const settings = this.facade.getSettings() as BackendSettings;
		// Azure Storage and the Team Server are independent targets; either toggle enables sync.
		if (!settings.enabled && !settings.sharingServerEnabled) {
			vscode.window.showWarningMessage(
				'Backend sync is disabled. Enable it in settings or run "Configure Backend" first.'
			);
			return;
		}

		// Gate on the same resolved targets the sync service uses, so the command can never
		// report success for a pass that uploads nothing.
		if (settings.sharingProfile === 'off') {
			vscode.window.showWarningMessage(t('backend.syncNow.profileOff'));
			return;
		}
		const targets = resolveSyncTargets(settings);
		if (!targets.azure && !targets.sharingServer) {
			vscode.window.showWarningMessage(t('backend.syncNow.notConfigured'));
			return;
		}

		const targetLabel = describeSyncTargets(targets);
		await withBackendErrorHandling(`sync to ${targetLabel}`, async () => {
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: t('backend.syncNow.progress', targetLabel),
					cancellable: false
				},
				async () => this.facade.syncToBackendStore(true)
			);
			// The sync service logs per-target failures instead of throwing, so report what it
			// says happened to each target rather than treating "returned" as "uploaded".
			const { synced, skipped, failed } = partitionSyncResult(result, targets);
			if (synced) {
				showBackendSuccess(t('backend.syncNow.synced', describeSyncTargets(synced)));
			}
			if (skipped || (!synced && !failed)) {
				vscode.window.showWarningMessage(t('backend.syncNow.nothingSent', skipped ? describeSyncTargets(skipped) : targetLabel));
			}
			if (failed) {
				throw new Error(t('backend.syncNow.failed', describeSyncTargets(failed)));
			}
		});
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

		await withBackendErrorHandling('query backend data', async () => {
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
		});
	}

	/**
	 * Handles the "Set Backend Shared Key" command.
	 */
	async handleSetBackendSharedKey(): Promise<void> {
		await withBackendErrorHandling('set shared key', () => this.facade.setBackendSharedKey());
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

		await withBackendErrorHandling('rotate shared key', () => this.facade.rotateBackendSharedKey());
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

		await withBackendErrorHandling('clear shared key', () => this.facade.clearBackendSharedKey());
	}

	/**
	 * Handles enabling team sharing (consent gate).
	 */
	async handleEnableTeamSharing(): Promise<void> {
		const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
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
		await withBackendErrorHandling('enable team sharing', async () => {
			await applySettingsAtomically(async () => {
				await config.update('backend.sharingProfile', 'teamPseudonymous', vscode.ConfigurationTarget.Global);
				await config.update('backend.shareWithTeam', true, vscode.ConfigurationTarget.Global);
				await config.update('backend.shareConsentAt', consentAt, vscode.ConfigurationTarget.Global);
			});
			vscode.window.showInformationMessage(SuccessMessages.completed('Team sharing enabled'));
		});
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

		const config = vscode.workspace.getConfiguration('aiEngineeringFluency');
		await withBackendErrorHandling('disable team sharing', async () => {
			await applySettingsAtomically(async () => {
				await config.update('backend.sharingProfile', 'teamAnonymized', vscode.ConfigurationTarget.Global);
				await config.update('backend.shareWithTeam', false, vscode.ConfigurationTarget.Global);
				await config.update('backend.shareWorkspaceMachineNames', false, vscode.ConfigurationTarget.Global);
			});
			vscode.window.showInformationMessage(SuccessMessages.completed('Switched to anonymized sharing'));
		});
	}

	/**
	 * Handles the "Clear Azure Settings" command.
	 */
	async handleClearAzureSettings(): Promise<void> {

		const confirmed = await vscode.window.showWarningMessage(
			'Clear all Azure settings?',
			{ modal: true, detail: 'This will remove all Azure resource IDs, credentials, and backend configuration. You will need to reconfigure the backend to use it again.' },
			'Clear Settings'
		);
		if (confirmed !== 'Clear Settings') {
			return;
		}

		await withBackendErrorHandling('clear Azure settings', () => this.facade.clearAzureSettingsCommand());
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

		await withBackendErrorHandling('export results', async () => {
			const payload = redactBackendQueryResultForExport(result, { includeIdentifiers });
			const json = JSON.stringify(payload, null, 2);
			await writeClipboardText(json);
			vscode.window.showInformationMessage(includeIdentifiers
				? SuccessMessages.exported('Query results with identifiers')
				: SuccessMessages.exported('Redacted query results'));
		});
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
