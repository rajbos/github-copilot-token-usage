/**
 * Copy backend configuration to clipboard (excluding secrets).
 * Useful for sharing setup with team members or support.
 */

import * as vscode from 'vscode';
import type { BackendSettings } from './settings';
import { writeClipboardText } from '../utils/clipboard';

/**
 * Configuration values to include in the copy payload.
 */
export interface BackendCopyConfigValues {
	enabled: boolean;
	backend: string;
	authMode: string;
	datasetId: string;
	sharingProfile: string;
	shareWithTeam: boolean;
	shareWorkspaceMachineNames: boolean;
	shareConsentAt: string;
	userIdentityMode: string;
	userId: string;
	userIdMode: string;
	subscriptionId: string;
	resourceGroup: string;
	storageAccount: string;
	aggTable: string;
	eventsTable: string;
	rawContainer: string;
	lookbackDays: number;
	includeMachineBreakdown: boolean;
}

/**
 * Copy payload structure (versioned).
 */
export interface BackendCopyPayloadV1 {
	version: 1;
	timestamp: string;
	config: BackendCopyConfigValues;
	machineId: string;
	extensionVersion: string;
	note: string;
}

/**
 * Copies the backend configuration to the clipboard (excluding secrets).
 * @param settings - The backend settings to copy
 * @returns True if successful
 */
export async function copyBackendConfigToClipboard(settings: BackendSettings): Promise<boolean> {
	try {
		const payload: BackendCopyPayloadV1 = {
			version: 1,
			timestamp: new Date().toISOString(),
			config: {
				enabled: settings.enabled,
				backend: settings.backend,
				authMode: settings.authMode,
				datasetId: settings.datasetId,
				sharingProfile: settings.sharingProfile,
				shareWithTeam: settings.shareWithTeam,
				shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames,
				shareConsentAt: settings.shareConsentAt ? '[REDACTED_TIMESTAMP]' : '',
				userIdentityMode: settings.userIdentityMode,
				userId: settings.userId ? '[REDACTED]' : '', // Redact userId for privacy
				userIdMode: settings.userIdMode,
				subscriptionId: settings.subscriptionId,
				resourceGroup: settings.resourceGroup,
				storageAccount: settings.storageAccount,
				aggTable: settings.aggTable,
				eventsTable: settings.eventsTable,
				rawContainer: settings.rawContainer,
				lookbackDays: settings.lookbackDays,
				includeMachineBreakdown: settings.includeMachineBreakdown
			},
			machineId: '<redacted>', // Fully redact machineId
			extensionVersion: vscode.extensions.getExtension('RobBos.copilot-token-tracker')?.packageJSON?.version || 'unknown',
			note: 'This config does NOT include secrets (Storage Shared Key), machineId, sessionId, or home directory. Share safely.'
		};

		const json = JSON.stringify(payload, null, 2);
		await writeClipboardText(json);
		
		vscode.window.showInformationMessage(
			'Backend configuration copied to clipboard (no secrets included).'
		);
		return true;
	} catch (error) {
		vscode.window.showErrorMessage(
			`Failed to copy config: ${error instanceof Error ? error.message : String(error)}`
		);
		return false;
	}
}

/**
 * Gets a formatted summary of the backend configuration.
 * @param settings - The backend settings
 * @returns Formatted summary string
 */
export function getBackendConfigSummary(settings: BackendSettings): string {
	const lines = [
		'Backend Configuration:',
		`  Enabled: ${settings.enabled}`,
		`  Backend: ${settings.backend}`,
		`  Auth Mode: ${settings.authMode}`,
		`  Dataset ID: ${settings.datasetId}`,
		`  User Identity Mode: ${settings.userIdentityMode}`,
		`  User ID: ${settings.userId ? '[SET]' : '[NOT SET]'}`,
		`  User ID Mode: ${settings.userIdMode}`,
		'',
		'Azure Resources:',
		`  Subscription: ${settings.subscriptionId || '[NOT SET]'}`,
		`  Resource Group: ${settings.resourceGroup || '[NOT SET]'}`,
		`  Storage Account: ${settings.storageAccount || '[NOT SET]'}`,
		`  Agg Table: ${settings.aggTable}`,
		`  Events Table: ${settings.eventsTable}`,
		`  Raw Container: ${settings.rawContainer}`,
		'',
		'Behavior:',
		`  Lookback Days: ${settings.lookbackDays}`,
		`  Include Machine Breakdown: ${settings.includeMachineBreakdown}`
	];
	return lines.join('\n');
}

/**
 * Builds backend config clipboard payload (legacy name for compatibility).
 * @param settings - The backend settings
 * @returns Copy payload
 */
export function buildBackendConfigClipboardPayload(settings: BackendSettings): BackendCopyPayloadV1 {
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		config: {
			enabled: settings.enabled,
			backend: settings.backend,
			authMode: settings.authMode,
			datasetId: settings.datasetId,
			sharingProfile: settings.sharingProfile,
			shareWithTeam: settings.shareWithTeam,
			shareWorkspaceMachineNames: settings.shareWorkspaceMachineNames,
			shareConsentAt: settings.shareConsentAt ? '[REDACTED_TIMESTAMP]' : '',
			userIdentityMode: settings.userIdentityMode,
			userId: settings.userId ? '[REDACTED]' : '',
			userIdMode: settings.userIdMode,
			subscriptionId: settings.subscriptionId,
			resourceGroup: settings.resourceGroup,
			storageAccount: settings.storageAccount,
			aggTable: settings.aggTable,
			eventsTable: settings.eventsTable,
			rawContainer: settings.rawContainer,
			lookbackDays: settings.lookbackDays,
			includeMachineBreakdown: settings.includeMachineBreakdown
		},
		machineId: '<redacted>',
		extensionVersion: 'unknown',
		note: 'This config does NOT include secrets (Storage Shared Key), machineId, sessionId, or home directory. Share safely.'
	};
}
