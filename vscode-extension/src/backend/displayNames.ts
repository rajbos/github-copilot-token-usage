/**
 * Display names storage and management for workspaces and machines.
 * Provides privacy-first local storage in globalState with cloud sync opt-in.
 */

import * as vscode from 'vscode';

const DISPLAY_NAMES_STORAGE_KEY = 'displayNames.v1';
const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * Mapping of IDs to display names.
 */
export interface DisplayNameMapping {
	workspaceNames: Record<string, string>;
	machineNames: Record<string, string>;
}

/**
 * Store for managing workspace and machine display names.
 * Names are stored in VS Code globalState (does not sync across machines).
 */
export class DisplayNameStore {
	constructor(private readonly globalState: vscode.Memento) {}

	/**
	 * Get the full display name mapping from storage.
	 */
	private getMapping(): DisplayNameMapping {
		return this.globalState.get<DisplayNameMapping>(DISPLAY_NAMES_STORAGE_KEY, {
			workspaceNames: {},
			machineNames: {}
		});
	}

	/**
	 * Save the display name mapping to storage.
	 */
	private async setMapping(mapping: DisplayNameMapping): Promise<void> {
		await this.globalState.update(DISPLAY_NAMES_STORAGE_KEY, mapping);
	}

	/**
	 * Validate and normalize a display name.
	 * @returns Normalized name or undefined if invalid
	 */
	private validateName(name: string | undefined): string | undefined {
		if (!name || typeof name !== 'string') {
			return undefined;
		}
		
		const trimmed = name.trim();
		if (!trimmed) {
			return undefined;
		}
		
		if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
			throw new Error(`Display name must not exceed ${MAX_DISPLAY_NAME_LENGTH} characters`);
		}
		
		return trimmed;
	}

	/**
	 * Get workspace display name by ID.
	 * Falls back to truncated ID if no name is set.
	 */
	getWorkspaceName(workspaceId: string): string {
		const mapping = this.getMapping();
		const name = mapping.workspaceNames[workspaceId];
		
		if (name && name.trim()) {
			return name;
		}
		
		// Fallback to truncated ID
		return this.truncateId(workspaceId);
	}

	/**
	 * Get machine display name by ID.
	 * Falls back to truncated ID if no name is set.
	 */
	getMachineName(machineId: string): string {
		const mapping = this.getMapping();
		const name = mapping.machineNames[machineId];
		
		if (name && name.trim()) {
			return name;
		}
		
		// Fallback to truncated ID
		return this.truncateId(machineId);
	}

	/**
	 * Get the raw workspace name (without fallback).
	 * Returns undefined if no name is set.
	 */
	getWorkspaceNameRaw(workspaceId: string): string | undefined {
		const mapping = this.getMapping();
		const name = mapping.workspaceNames[workspaceId];
		return name && name.trim() ? name : undefined;
	}

	/**
	 * Get the raw machine name (without fallback).
	 * Returns undefined if no name is set.
	 */
	getMachineNameRaw(machineId: string): string | undefined {
		const mapping = this.getMapping();
		const name = mapping.machineNames[machineId];
		return name && name.trim() ? name : undefined;
	}

	/**
	 * Set workspace display name.
	 * Pass empty string or undefined to remove the name.
	 */
	async setWorkspaceName(workspaceId: string, name: string | undefined): Promise<void> {
		const mapping = this.getMapping();
		
		const validated = this.validateName(name);
		if (validated) {
			mapping.workspaceNames[workspaceId] = validated;
		} else {
			// Remove the name if validation fails or empty
			delete mapping.workspaceNames[workspaceId];
		}
		
		await this.setMapping(mapping);
	}

	/**
	 * Set machine display name.
	 * Pass empty string or undefined to remove the name.
	 */
	async setMachineName(machineId: string, name: string | undefined): Promise<void> {
		const mapping = this.getMapping();
		
		const validated = this.validateName(name);
		if (validated) {
			mapping.machineNames[machineId] = validated;
		} else {
			// Remove the name if validation fails or empty
			delete mapping.machineNames[machineId];
		}
		
		await this.setMapping(mapping);
	}

	/**
	 * Get all workspace names.
	 */
	getAllWorkspaceNames(): Record<string, string> {
		const mapping = this.getMapping();
		return { ...mapping.workspaceNames };
	}

	/**
	 * Get all machine names.
	 */
	getAllMachineNames(): Record<string, string> {
		const mapping = this.getMapping();
		return { ...mapping.machineNames };
	}

	/**
	 * Clear all workspace names.
	 */
	async clearAllWorkspaceNames(): Promise<void> {
		const mapping = this.getMapping();
		mapping.workspaceNames = {};
		await this.setMapping(mapping);
	}

	/**
	 * Clear all machine names.
	 */
	async clearAllMachineNames(): Promise<void> {
		const mapping = this.getMapping();
		mapping.machineNames = {};
		await this.setMapping(mapping);
	}

	/**
	 * Clear all display names (workspaces and machines).
	 */
	async clearAll(): Promise<void> {
		await this.setMapping({
			workspaceNames: {},
			machineNames: {}
		});
	}

	/**
	 * Truncate an ID to first 6 characters with ellipsis.
	 */
	private truncateId(id: string): string {
		if (!id || id.length <= 8) {
			return id || 'unknown';
		}
		return `${id.substring(0, 6)}...`;
	}

	/**
	 * Check if a workspace has a display name set.
	 */
	hasWorkspaceName(workspaceId: string): boolean {
		return this.getWorkspaceNameRaw(workspaceId) !== undefined;
	}

	/**
	 * Check if a machine has a display name set.
	 */
	hasMachineName(machineId: string): boolean {
		return this.getMachineNameRaw(machineId) !== undefined;
	}
}
