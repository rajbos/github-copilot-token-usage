import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import type * as vscode from 'vscode';
import type { BackendSettings } from '../../src/backend/settings';
import { BackendIntegration } from '../../src/backend/integration';

test('BackendIntegration - constructor stores dependencies', () => {
	const logCalls: string[] = [];
	const warnCalls: string[] = [];
	const errorCalls: any[] = [];
	const updateTokenStatsCalls: number[] = [];
	const toUtcDayKeyCalls: string[] = [];
	
	const facade = {
		getSettings: () => ({ test: 'settings' } as unknown as BackendSettings),
		isConfigured: (s: any) => true,
		syncToBackendStore: async () => {},
		getStatsForDetailsPanel: async () => ({ stats: true }),
		setFilters: (f: any) => {}
	};
	
	const context = { workspaceState: { get: () => {}, update: () => {} } } as unknown as vscode.ExtensionContext;
	
	const integration = new BackendIntegration({
		facade,
		context,
		log: (m) => { logCalls.push(m); },
		warn: (m) => { warnCalls.push(m); },
		error: (m, e) => { errorCalls.push({ m, e }); },
		updateTokenStats: async () => { updateTokenStatsCalls.push(1); },
		toUtcDayKey: (d) => { toUtcDayKeyCalls.push(d.toISOString()); return '2024-01-01'; }
	});
	
	assert.equal(logCalls.length, 0, 'Should not log on construction');
});

test('BackendIntegration - getContext returns stored context', () => {
	const context = { workspaceState: { get: () => {}, update: () => {} } } as unknown as vscode.ExtensionContext;
	
	const integration = new BackendIntegration({
		facade: {
			getSettings: () => ({} as unknown as BackendSettings),
			isConfigured: () => true,
			syncToBackendStore: async () => {},
			getStatsForDetailsPanel: async () => ({}),
			setFilters: () => {}
		},
		context,
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	assert.equal(integration.getContext(), context);
});

test('BackendIntegration - getContext returns undefined when no context', () => {
	const integration = new BackendIntegration({
		facade: {
			getSettings: () => ({} as unknown as BackendSettings),
			isConfigured: () => true,
			syncToBackendStore: async () => {},
			getStatsForDetailsPanel: async () => ({}),
			setFilters: () => {}
		},
		context: undefined,
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	assert.equal(integration.getContext(), undefined);
});

test('BackendIntegration - log prefixes message with [Backend]', () => {
	const logCalls: string[] = [];
	
	const integration = new BackendIntegration({
		facade: {
			getSettings: () => ({} as unknown as BackendSettings),
			isConfigured: () => true,
			syncToBackendStore: async () => {},
			getStatsForDetailsPanel: async () => ({}),
			setFilters: () => {}
		},
		log: (m) => { logCalls.push(m); },
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	integration.log('test message');
	
	assert.equal(logCalls.length, 1);
	assert.equal(logCalls[0], '[Backend] test message');
});

test('BackendIntegration - warn calls warn function', () => {
	const warnCalls: string[] = [];
	
	const integration = new BackendIntegration({
		facade: {
			getSettings: () => ({} as unknown as BackendSettings),
			isConfigured: () => true,
			syncToBackendStore: async () => {},
			getStatsForDetailsPanel: async () => ({}),
			setFilters: () => {}
		},
		log: () => {},
		warn: (m) => { warnCalls.push(m); },
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	integration.warn('warning message');
	
	assert.equal(warnCalls.length, 1);
	assert.equal(warnCalls[0], 'warning message');
});

test('BackendIntegration - error calls error function with error', () => {
	const errorCalls: any[] = [];
	
	const integration = new BackendIntegration({
		facade: {
			getSettings: () => ({} as unknown as BackendSettings),
			isConfigured: () => true,
			syncToBackendStore: async () => {},
			getStatsForDetailsPanel: async () => ({}),
			setFilters: () => {}
		},
		log: () => {},
		warn: () => {},
		error: (m, e) => { errorCalls.push({ m, e }); },
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	const testError = new Error('test error');
	integration.error('error message', testError);
	
	assert.equal(errorCalls.length, 1);
	assert.equal(errorCalls[0].m, 'error message');
	assert.equal(errorCalls[0].e, testError);
});

test('BackendIntegration - toUtcDayKey delegates to toUtcDayKeyFn', () => {
	const toUtcDayKeyCalls: Date[] = [];
	
	const integration = new BackendIntegration({
		facade: {
			getSettings: () => ({} as unknown as BackendSettings),
			isConfigured: () => true,
			syncToBackendStore: async () => {},
			getStatsForDetailsPanel: async () => ({}),
			setFilters: () => {}
		},
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: (d) => { toUtcDayKeyCalls.push(d); return '2024-01-01'; }
	});
	
	const date = new Date('2024-06-09');
	const result = integration.toUtcDayKey(date);
	
	assert.equal(result, '2024-01-01');
	assert.equal(toUtcDayKeyCalls.length, 1);
	assert.equal(toUtcDayKeyCalls[0], date);
});

test('BackendIntegration - updateTokenStats delegates to updateTokenStatsFn', async () => {
	const updateTokenStatsCalls: number[] = [];
	
	const integration = new BackendIntegration({
		facade: {
			getSettings: () => ({} as unknown as BackendSettings),
			isConfigured: () => true,
			syncToBackendStore: async () => {},
			getStatsForDetailsPanel: async () => ({}),
			setFilters: () => {}
		},
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => { updateTokenStatsCalls.push(1); },
		toUtcDayKey: () => '2024-01-01'
	});
	
	await integration.updateTokenStats();
	
	assert.equal(updateTokenStatsCalls.length, 1);
});

test('BackendIntegration - getSettings delegates to facade', () => {
	const facade = {
		getSettings: () => ({ test: 'value' } as unknown as BackendSettings),
		isConfigured: () => true,
		syncToBackendStore: async () => {},
		getStatsForDetailsPanel: async () => ({}),
		setFilters: () => {}
	};
	
	const integration = new BackendIntegration({
		facade,
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	const settings = integration.getSettings();
	
	assert.deepEqual(settings, { test: 'value' });
});

test('BackendIntegration - isConfigured delegates to facade', () => {
	const facade = {
		getSettings: () => ({} as unknown as BackendSettings),
		isConfigured: (s: any) => s?.enabled === true,
		syncToBackendStore: async () => {},
		getStatsForDetailsPanel: async () => ({}),
		setFilters: () => {}
	};
	
	const integration = new BackendIntegration({
		facade,
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	const result1 = integration.isConfigured({ enabled: true });
	const result2 = integration.isConfigured({ enabled: false });
	
	assert.equal(result1, true);
	assert.equal(result2, false);
});

test('BackendIntegration - syncToBackendStore delegates to facade', async () => {
	const syncCalls: boolean[] = [];
	
	const facade = {
		getSettings: () => ({} as unknown as BackendSettings),
		isConfigured: () => true,
		syncToBackendStore: async (force: boolean) => { syncCalls.push(force); },
		getStatsForDetailsPanel: async () => ({}),
		setFilters: () => {}
	};
	
	const integration = new BackendIntegration({
		facade,
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	await integration.syncToBackendStore(true);
	
	assert.equal(syncCalls.length, 1);
	assert.equal(syncCalls[0], true);
});

test('BackendIntegration - getStatsForDetailsPanel delegates to facade', async () => {
	const facadeStats = { total: 100 };
	
	const facade = {
		getSettings: () => ({} as unknown as BackendSettings),
		isConfigured: () => true,
		syncToBackendStore: async () => {},
		getStatsForDetailsPanel: async () => facadeStats,
		setFilters: () => {}
	};
	
	const integration = new BackendIntegration({
		facade,
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => ({ fallback: true }),
		toUtcDayKey: () => '2024-01-01'
	});
	
	const stats = await integration.getStatsForDetailsPanel();
	
	assert.equal(stats, facadeStats);
});

test('BackendIntegration - getStatsForDetailsPanel falls back to updateTokenStats when facade returns null', async () => {
	const facade = {
		getSettings: () => ({} as unknown as BackendSettings),
		isConfigured: () => true,
		syncToBackendStore: async () => {},
		getStatsForDetailsPanel: async () => null,
		setFilters: () => {}
	};
	
	const updateTokenStatsCalls: number[] = [];
	
	const integration = new BackendIntegration({
		facade,
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => { updateTokenStatsCalls.push(1); return { fallback: true }; },
		toUtcDayKey: () => '2024-01-01'
	});
	
	const stats = await integration.getStatsForDetailsPanel();
	
	assert.deepEqual(stats, { fallback: true });
	assert.equal(updateTokenStatsCalls.length, 1);
});

test('BackendIntegration - setFilters delegates to facade', () => {
	const filtersReceived: any[] = [];
	
	const facade = {
		getSettings: () => ({} as unknown as BackendSettings),
		isConfigured: () => true,
		syncToBackendStore: async () => {},
		getStatsForDetailsPanel: async () => ({}),
		setFilters: (f: any) => { filtersReceived.push(f); }
	};
	
	const integration = new BackendIntegration({
		facade,
		log: () => {},
		warn: () => {},
		error: () => {},
		updateTokenStats: async () => {},
		toUtcDayKey: () => '2024-01-01'
	});
	
	const filters = { model: 'gpt-4' };
	integration.setFilters(filters);
	
	assert.equal(filtersReceived.length, 1);
	assert.equal(filtersReceived[0], filters);
});
