/**
 * Tests for display names storage and management.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DisplayNameStore } from '../backend/displayNames';


suite('DisplayNameStore', () => {
	let mockGlobalState: vscode.Memento;
	let store: DisplayNameStore;
	let storage: Map<string, any>;

	setup(() => {
		storage = new Map();
		mockGlobalState = {
			get: (key: string, defaultValue?: any) => storage.get(key) ?? defaultValue,
			update: async (key: string, value: any) => {
				storage.set(key, value);
			},
			keys: () => Array.from(storage.keys())
		};
		store = new DisplayNameStore(mockGlobalState);
	});

	suite('getWorkspaceName', () => {
		test('should return truncated ID when no name is set', () => {
			const id = 'abc123def456ghi789';
			const result = store.getWorkspaceName(id);
			assert.strictEqual(result, 'abc123...');
		});

		test('should return the display name when set', async () => {
			const id = 'workspace-1';
			await store.setWorkspaceName(id, 'My Project');
			const result = store.getWorkspaceName(id);
			assert.strictEqual(result, 'My Project');
		});

		test('should return truncated ID for short IDs', () => {
			const id = 'abc';
			const result = store.getWorkspaceName(id);
			assert.strictEqual(result, 'abc');
		});

		test('should handle empty storage gracefully', () => {
			const result = store.getWorkspaceName('test-id');
			assert.strictEqual(result, 'test-id');
		});
	});

	suite('getMachineName', () => {
		test('should return truncated ID when no name is set', () => {
			const id = 'machine-abc123def456';
			const result = store.getMachineName(id);
			assert.strictEqual(result, 'machin...');
		});

		test('should return the display name when set', async () => {
			const id = 'machine-1';
			await store.setMachineName(id, 'Main Laptop');
			const result = store.getMachineName(id);
			assert.strictEqual(result, 'Main Laptop');
		});
	});

	suite('getWorkspaceNameRaw', () => {
		test('should return undefined when no name is set', () => {
			const result = store.getWorkspaceNameRaw('workspace-1');
			assert.strictEqual(result, undefined);
		});

		test('should return the name when set', async () => {
			await store.setWorkspaceName('workspace-1', 'Test');
			const result = store.getWorkspaceNameRaw('workspace-1');
			assert.strictEqual(result, 'Test');
		});

		test('should return undefined for empty name', async () => {
			await store.setWorkspaceName('workspace-1', '   ');
			const result = store.getWorkspaceNameRaw('workspace-1');
			assert.strictEqual(result, undefined);
		});
	});

	suite('getMachineNameRaw', () => {
		test('should return undefined when no name is set', () => {
			const result = store.getMachineNameRaw('machine-1');
			assert.strictEqual(result, undefined);
		});

		test('should return the name when set', async () => {
			await store.setMachineName('machine-1', 'Laptop');
			const result = store.getMachineNameRaw('machine-1');
			assert.strictEqual(result, 'Laptop');
		});
	});

	suite('setWorkspaceName', () => {
		test('should set a valid workspace name', async () => {
			await store.setWorkspaceName('ws-1', 'Project Alpha');
			assert.strictEqual(store.getWorkspaceName('ws-1'), 'Project Alpha');
		});

		test('should trim whitespace', async () => {
			await store.setWorkspaceName('ws-1', '  Project Beta  ');
			assert.strictEqual(store.getWorkspaceName('ws-1'), 'Project Beta');
		});

		test('should remove name when passed empty string', async () => {
			await store.setWorkspaceName('ws-1', 'Test');
			await store.setWorkspaceName('ws-1', '');
			assert.strictEqual(store.getWorkspaceNameRaw('ws-1'), undefined);
		});

		test('should remove name when passed undefined', async () => {
			await store.setWorkspaceName('ws-1', 'Test');
			await store.setWorkspaceName('ws-1', undefined);
			assert.strictEqual(store.getWorkspaceNameRaw('ws-1'), undefined);
		});

		test('should reject names longer than 64 characters', async () => {
			const longName = 'A'.repeat(65);
			await assert.rejects(
				async () => store.setWorkspaceName('ws-1', longName),
				/Display name must not exceed 64 characters/
			);
		});

		test('should accept names exactly 64 characters', async () => {
			const exactName = 'A'.repeat(64);
			await store.setWorkspaceName('ws-1', exactName);
			assert.strictEqual(store.getWorkspaceName('ws-1'), exactName);
		});

		test('should handle special characters', async () => {
			await store.setWorkspaceName('ws-1', 'Project (2024-Q1)');
			assert.strictEqual(store.getWorkspaceName('ws-1'), 'Project (2024-Q1)');
		});

		test('should handle unicode characters', async () => {
			await store.setWorkspaceName('ws-1', 'プロジェクト');
			assert.strictEqual(store.getWorkspaceName('ws-1'), 'プロジェクト');
		});
	});

	suite('setMachineName', () => {
		test('should set a valid machine name', async () => {
			await store.setMachineName('m-1', 'Home Desktop');
			assert.strictEqual(store.getMachineName('m-1'), 'Home Desktop');
		});

		test('should trim whitespace', async () => {
			await store.setMachineName('m-1', '  Work Laptop  ');
			assert.strictEqual(store.getMachineName('m-1'), 'Work Laptop');
		});

		test('should remove name when passed empty string', async () => {
			await store.setMachineName('m-1', 'Test');
			await store.setMachineName('m-1', '');
			assert.strictEqual(store.getMachineNameRaw('m-1'), undefined);
		});

		test('should reject names longer than 64 characters', async () => {
			const longName = 'M'.repeat(65);
			await assert.rejects(
				async () => store.setMachineName('m-1', longName),
				/Display name must not exceed 64 characters/
			);
		});
	});

	suite('getAllWorkspaceNames', () => {
		test('should return empty object when no names are set', () => {
			const result = store.getAllWorkspaceNames();
			assert.deepStrictEqual(result, {});
		});

		test('should return all workspace names', async () => {
			await store.setWorkspaceName('ws-1', 'Project A');
			await store.setWorkspaceName('ws-2', 'Project B');
			const result = store.getAllWorkspaceNames();
			assert.deepStrictEqual(result, {
				'ws-1': 'Project A',
				'ws-2': 'Project B'
			});
		});

		test('should return a copy (not live reference)', async () => {
			await store.setWorkspaceName('ws-1', 'Test');
			const result = store.getAllWorkspaceNames();
			result['ws-2'] = 'Modified';
			
			const second = store.getAllWorkspaceNames();
			assert.strictEqual(second['ws-2'], undefined);
		});
	});

	suite('getAllMachineNames', () => {
		test('should return empty object when no names are set', () => {
			const result = store.getAllMachineNames();
			assert.deepStrictEqual(result, {});
		});

		test('should return all machine names', async () => {
			await store.setMachineName('m-1', 'Laptop');
			await store.setMachineName('m-2', 'Desktop');
			const result = store.getAllMachineNames();
			assert.deepStrictEqual(result, {
				'm-1': 'Laptop',
				'm-2': 'Desktop'
			});
		});
	});

	suite('clearAllWorkspaceNames', () => {
		test('should clear all workspace names', async () => {
			await store.setWorkspaceName('ws-1', 'Project A');
			await store.setWorkspaceName('ws-2', 'Project B');
			await store.clearAllWorkspaceNames();
			
			const result = store.getAllWorkspaceNames();
			assert.deepStrictEqual(result, {});
		});

		test('should not affect machine names', async () => {
			await store.setWorkspaceName('ws-1', 'Project');
			await store.setMachineName('m-1', 'Laptop');
			await store.clearAllWorkspaceNames();
			
			assert.strictEqual(store.getMachineName('m-1'), 'Laptop');
		});
	});

	suite('clearAllMachineNames', () => {
		test('should clear all machine names', async () => {
			await store.setMachineName('m-1', 'Laptop');
			await store.setMachineName('m-2', 'Desktop');
			await store.clearAllMachineNames();
			
			const result = store.getAllMachineNames();
			assert.deepStrictEqual(result, {});
		});

		test('should not affect workspace names', async () => {
			await store.setWorkspaceName('ws-1', 'Project');
			await store.setMachineName('m-1', 'Laptop');
			await store.clearAllMachineNames();
			
			assert.strictEqual(store.getWorkspaceName('ws-1'), 'Project');
		});
	});

	suite('clearAll', () => {
		test('should clear all display names', async () => {
			await store.setWorkspaceName('ws-1', 'Project');
			await store.setMachineName('m-1', 'Laptop');
			await store.clearAll();
			
			assert.deepStrictEqual(store.getAllWorkspaceNames(), {});
			assert.deepStrictEqual(store.getAllMachineNames(), {});
		});
	});

	suite('hasWorkspaceName', () => {
		test('should return false when no name is set', () => {
			assert.strictEqual(store.hasWorkspaceName('ws-1'), false);
		});

		test('should return true when name is set', async () => {
			await store.setWorkspaceName('ws-1', 'Test');
			assert.strictEqual(store.hasWorkspaceName('ws-1'), true);
		});

		test('should return false after name is removed', async () => {
			await store.setWorkspaceName('ws-1', 'Test');
			await store.setWorkspaceName('ws-1', '');
			assert.strictEqual(store.hasWorkspaceName('ws-1'), false);
		});
	});

	suite('hasMachineName', () => {
		test('should return false when no name is set', () => {
			assert.strictEqual(store.hasMachineName('m-1'), false);
		});

		test('should return true when name is set', async () => {
			await store.setMachineName('m-1', 'Laptop');
			assert.strictEqual(store.hasMachineName('m-1'), true);
		});
	});

	suite('persistence', () => {
		test('should persist names across store instances', async () => {
			await store.setWorkspaceName('ws-1', 'Persistent');
			await store.setMachineName('m-1', 'Machine');
			
			// Create new store with same globalState
			const newStore = new DisplayNameStore(mockGlobalState);
			assert.strictEqual(newStore.getWorkspaceName('ws-1'), 'Persistent');
			assert.strictEqual(newStore.getMachineName('m-1'), 'Machine');
		});

		test('should persist deletions', async () => {
			await store.setWorkspaceName('ws-1', 'Test');
			await store.setWorkspaceName('ws-1', '');
			
			const newStore = new DisplayNameStore(mockGlobalState);
			assert.strictEqual(newStore.getWorkspaceNameRaw('ws-1'), undefined);
		});
	});

	suite('edge cases', () => {
		test('should handle empty string ID', () => {
			const result = store.getWorkspaceName('');
			assert.strictEqual(result, 'unknown');
		});

		test('should handle multiple spaces in name', async () => {
			await store.setWorkspaceName('ws-1', '  Multiple   Spaces  ');
			// Should trim leading/trailing but preserve internal spaces
			assert.strictEqual(store.getWorkspaceName('ws-1'), 'Multiple   Spaces');
		});

		test('should handle name with only whitespace', async () => {
			await store.setWorkspaceName('ws-1', 'Valid');
			await store.setWorkspaceName('ws-1', '     ');
			assert.strictEqual(store.getWorkspaceNameRaw('ws-1'), undefined);
		});

		test('should handle concurrent operations', async () => {
			// Set multiple names in parallel
			await Promise.all([
				store.setWorkspaceName('ws-1', 'A'),
				store.setWorkspaceName('ws-2', 'B'),
				store.setMachineName('m-1', 'C')
			]);

			assert.strictEqual(store.getWorkspaceName('ws-1'), 'A');
			assert.strictEqual(store.getWorkspaceName('ws-2'), 'B');
			assert.strictEqual(store.getMachineName('m-1'), 'C');
		});
	});
});
