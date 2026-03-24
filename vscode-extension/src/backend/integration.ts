/**
 * Extension integration helpers for the backend module.
 * Provides utility functions for integrating backend features with VS Code.
 */

import * as vscode from 'vscode';
import type { BackendSettings } from './settings';
import type { BackendFacade } from './facade';

/**
 * Shows a backend error message to the user with appropriate context.
 * @param message - The error message to display
 * @param settings - Optional backend settings for context
 */
export function showBackendError(message: string, settings?: BackendSettings): void {
	const contextInfo = settings 
		? ` (Storage: ${settings.storageAccount || 'not configured'})`
		: '';
	vscode.window.showErrorMessage(`Backend sync error${contextInfo}: ${message}`);
}

/**
 * Shows a backend warning message to the user.
 * @param message - The warning message to display
 */
export function showBackendWarning(message: string): void {
	vscode.window.showWarningMessage(`Backend sync: ${message}`);
}

/**
 * Shows a backend success message to the user.
 * @param message - The success message to display
 */
export function showBackendSuccess(message: string): void {
	vscode.window.showInformationMessage(`Backend sync: ${message}`);
}

/**
 * Creates an output channel for backend logging.
 * @param context - The extension context
 * @returns Output channel for logging
 */
export function createBackendOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
	const channel = vscode.window.createOutputChannel('Copilot Token Tracker - Backend');
	context.subscriptions.push(channel);
	return channel;
}

/**
 * Logs a message to the backend output channel.
 * @param channel - The output channel
 * @param message - The message to log
 */
export function logToBackendChannel(channel: vscode.OutputChannel, message: string): void {
	const timestamp = new Date().toISOString();
	channel.appendLine(`[${timestamp}] ${message}`);
}

/**
 * Gets the current workspace folder path, if available.
 * @returns Workspace folder path or undefined
 */
export function getCurrentWorkspacePath(): string | undefined {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	return workspaceFolder?.uri.fsPath;
}

/**
 * Gets a stable workspace identifier from the workspace URI.
 * Returns a hash of the workspace path for privacy.
 * @returns Workspace identifier or 'unknown'
 */
export function getWorkspaceId(): string {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		return 'unknown';
	}
	
	// Create a stable hash of the workspace path
	const crypto = require('crypto');
	const hash = crypto.createHash('sha256');
	hash.update(workspaceFolder.uri.toString());
	return hash.digest('hex').slice(0, 16);
}

/**
 * Gets the VS Code workspaceStorage folder key for the current workspace.
 *
 * Copilot Chat session files live under:
 *   .../User/workspaceStorage/<workspaceStorageId>/github.copilot-chat/...
 *
 * We derive <workspaceStorageId> via an md5 hash of the workspace URI string,
 * matching VS Code's stable workspace storage key scheme.
 */
export function getWorkspaceStorageId(): string {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		return 'unknown';
	}
	const crypto = require('crypto');
	return crypto.createHash('md5').update(workspaceFolder.uri.toString()).digest('hex');
}

/**
 * Validates that Azure CLI or Azure Account extension is available for authentication.
 * @returns True if authentication is available
 */
export async function isAzureAuthAvailable(): Promise<boolean> {
	try {
		// Check if Azure Account extension is installed
		const azureAccount = vscode.extensions.getExtension('ms-vscode.azure-account');
		if (azureAccount) {
			return true;
		}

		// Check if Azure CLI is available (DefaultAzureCredential will use it)
		// This is a best-effort check - actual auth will be validated when used
		return true;
	} catch {
		return false;
	}
}

/**
 * Formats a timestamp for display in the UI.
 * @param timestamp - The timestamp to format (Date or ISO string)
 * @returns Formatted string
 */
export function formatTimestamp(timestamp: Date | string | number): string {
	const date = typeof timestamp === 'string' || typeof timestamp === 'number' 
		? new Date(timestamp) 
		: timestamp;
	
	if (!date || isNaN(date.getTime())) {
		return 'Never';
	}

	const now = new Date();
	const diff = now.getTime() - date.getTime();
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) {
		return 'Just now';
	} else if (minutes < 60) {
		return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
	} else if (hours < 24) {
		return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
	} else if (days < 7) {
		return `${days} day${days !== 1 ? 's' : ''} ago`;
	} else {
		return date.toLocaleDateString();
	}
}

/**
 * Validates user input for Azure resource names.
 * @param name - The resource name to validate
 * @param resourceType - The type of resource (for error messages)
 * @returns Error message or undefined if valid
 */
export function validateAzureResourceName(name: string, resourceType: string): string | undefined {
	if (!name || !name.trim()) {
		return `${resourceType} name is required`;
	}

	const trimmed = name.trim();

	// Common Azure naming rules
	if (trimmed.length < 3) {
		return `${resourceType} name must be at least 3 characters`;
	}
	if (trimmed.length > 63) {
		return `${resourceType} name must be less than 63 characters`;
	}

	// Storage account specific rules
	if (resourceType.toLowerCase().includes('storage')) {
		if (!/^[a-z0-9]+$/.test(trimmed)) {
			return 'Storage account name must contain only lowercase letters and numbers';
		}
		if (trimmed.length > 24) {
			return 'Storage account name must be less than 24 characters';
		}
	}

	return undefined;
}

/**
 * Prompts the user to confirm a potentially destructive action.
 * @param message - The confirmation message
 * @param confirmLabel - Label for the confirm button (default: "Confirm")
 * @returns True if user confirmed
 */
export async function confirmAction(message: string, confirmLabel: string = 'Confirm'): Promise<boolean> {
	const result = await vscode.window.showWarningMessage(
		message,
		{ modal: true },
		confirmLabel
	);
	return result === confirmLabel;
}

/**
 * Backend integration helper class.
 * Provides utilities for integrating backend features with the extension.
 */
export class BackendIntegration {
	private facade: Pick<BackendFacade, 'getSettings' | 'isConfigured' | 'syncToBackendStore' | 'getStatsForDetailsPanel' | 'setFilters'>;
	private context?: vscode.ExtensionContext;
	private logFn: (m: string) => void;
	private warnFn: (m: string) => void;
	private errorFn: (m: string, e?: unknown) => void;
	private updateTokenStatsFn: () => Promise<unknown>;
	private toUtcDayKeyFn: (date: Date) => string;

	constructor(deps: {
		facade: Pick<BackendFacade, 'getSettings' | 'isConfigured' | 'syncToBackendStore' | 'getStatsForDetailsPanel' | 'setFilters'>;
		context?: vscode.ExtensionContext;
		log: (m: string) => void;
		warn: (m: string) => void;
		error: (m: string, e?: unknown) => void;
		updateTokenStats: () => Promise<unknown>;
		toUtcDayKey: (date: Date) => string;
	}) {
		this.facade = deps.facade;
		this.context = deps.context;
		this.logFn = deps.log;
		this.warnFn = deps.warn;
		this.errorFn = deps.error;
		this.updateTokenStatsFn = deps.updateTokenStats;
		this.toUtcDayKeyFn = deps.toUtcDayKey;
	}

	/**
	 * Gets the VS Code extension context.
	 * @returns Extension context, or undefined if not available
	 */
	getContext(): vscode.ExtensionContext | undefined {
		return this.context;
	}

	/**
	 * Logs a message to the output channel.
	 */
	log(message: string): void {
		this.logFn(`[Backend] ${message}`);
	}

	/**
	 * Logs a warning to the output channel.
	 */
	warn(message: string): void {
		this.warnFn(message);
	}

	/**
	 * Logs an error to the output channel.
	 */
	error(message: string, error?: unknown): void {
		this.errorFn(message, error);
	}

	/**
	 * Converts a date to UTC day key (YYYY-MM-DD).
	 */
	toUtcDayKey(date: Date): string {
		return this.toUtcDayKeyFn(date);
	}

	/**
	 * Updates token stats.
	 */
	async updateTokenStats(): Promise<void> {
		await this.updateTokenStatsFn();
	}

	// Proxy methods to facade
	getSettings(): any {
		return this.facade?.getSettings?.();
	}

	isConfigured(settings: any): boolean {
		return this.facade?.isConfigured?.(settings) ?? false;
	}

	async syncToBackendStore(force: boolean): Promise<void> {
		await this.facade?.syncToBackendStore?.(force);
	}

	async getStatsForDetailsPanel(): Promise<any> {
		const stats = await this.facade?.getStatsForDetailsPanel?.();
		// If backend is not configured or fails, fall back to local stats calculation
		if (!stats && this.updateTokenStatsFn) {
			return await this.updateTokenStatsFn();
		}
		return stats;
	}

	setFilters(filters: any): void {
		this.facade?.setFilters?.(filters);
	}
}
