/**
 * Unit tests for SharingServerUploadService.
 * Tests the HTTP upload functionality for the self-hosted sharing server.
 */

import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import { SharingServerUploadService, packEntriesByDay } from '../../src/backend/services/sharingServerUploadService';

// Mock global fetch
let mockFetchResponse: Response | undefined;
let mockFetchCalls: Array<{ url: string; options: RequestInit; body?: string }> = [];

test.beforeEach(() => {
	mockFetchCalls = [];
	mockFetchResponse = undefined;
	
	global.fetch = async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
		const urlStr = typeof url === 'string' ? url : url.toString();
		const body = options?.body ? JSON.parse(options.body.toString()) : null;
		const batchSize = Array.isArray(body) ? body.length : 1;
		
		mockFetchCalls.push({
			url: urlStr,
			options: options || {},
			body: options?.body ? options.body.toString() : undefined
		});
		
		if (mockFetchResponse) {
			return mockFetchResponse;
		}
		
		// The fluency-score endpoint confirms with { ok: true }; the upload
		// endpoint reports how many entries it stored.
		if (urlStr.includes('/api/fluency-score')) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				statusText: 'OK'
			});
		}
		
		// Default to successful response with all entries uploaded
		return new Response(JSON.stringify({ uploaded: batchSize }), {
			status: 200,
			statusText: 'OK'
		});
	};
});

test.afterEach(() => {
	mockFetchCalls = [];
	mockFetchResponse = undefined;
	delete (global as any).fetch;
});

// Helper to create test entries
function createTestEntry(day: string = '2024-01-01'): any {
	return {
		day,
		model: 'gpt-4',
		workspaceId: 'workspace-1',
		workspaceName: 'Test Workspace',
		machineId: 'machine-1',
		machineName: 'Test Machine',
		editor: 'VS Code',
		inputTokens: 1000,
		outputTokens: 500,
		interactions: 5,
		datasetId: 'default',
		fluencyMetrics: { score: 0.8 }
	};
}

// Test suite for uploadRollups
// ==============================

test('uploadRollups: successful upload with single batch', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry(), createTestEntry('2024-01-02')];
	
	const logMsgs: string[] = [];
	const warnMsgs: string[] = [];
	
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		(msg) => logMsgs.push(msg),
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(result.success, true);
	assert.equal(result.entriesUploaded, 2);
	assert.equal(mockFetchCalls.length, 1);
	assert.ok(mockFetchCalls[0].url.includes('/api/upload'));
	const headers = mockFetchCalls[0].options?.headers as Record<string, string> | undefined;
	assert.ok(headers?.['Authorization']?.includes('Bearer github-token'));
	assert.ok(logMsgs.some(msg => msg.includes('Uploaded 2 entries')));
});

test('uploadRollups: successful upload with multiple batches', async () => {
	const service = new SharingServerUploadService();
	const entries = [];
	
	// Create 1000 entries (more than BATCH_SIZE of 500)
	for (let i = 0; i < 1000; i++) {
		entries.push(createTestEntry(`2024-01-${String(i % 30 + 1).padStart(2, '0')}`));
	}
	
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		() => {}
	);
	
	assert.equal(result.success, true);
	assert.equal(result.entriesUploaded, 1000);
	// Whole days per request: 30 days of ~33 entries pack into 3 requests of <= 500.
	assert.equal(mockFetchCalls.length, 3);
	const daysPerRequest = mockFetchCalls.map(c => new Set((JSON.parse(c.body!) as Array<{ day: string }>).map(e => e.day)));
	for (let i = 0; i < daysPerRequest.length; i++) {
		assert.ok(JSON.parse(mockFetchCalls[i].body!).length <= 500);
		for (let j = i + 1; j < daysPerRequest.length; j++) {
			for (const day of daysPerRequest[i]) {
				assert.ok(!daysPerRequest[j].has(day), `day ${day} split across requests ${i} and ${j} — the server would delete the first part`);
			}
		}
	}
});

test('uploadRollups: a day over the request limit is skipped and reported, not split', async () => {
	const service = new SharingServerUploadService();
	const entries = [];
	for (let i = 0; i < 501; i++) { entries.push(createTestEntry('2024-02-01')); }
	entries.push(createTestEntry('2024-02-02'));
	const warnMsgs: string[] = [];
	const result = await service.uploadRollups('https://server.example.com', 'github-token', entries, () => {}, (m) => warnMsgs.push(m));
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 1);
	assert.equal(mockFetchCalls.length, 1);
	assert.ok(!mockFetchCalls[0].body!.includes('2024-02-01'), 'the oversized day must not be sent in parts');
	assert.ok(warnMsgs.some(m => m.includes('2024-02-01')));
});

test('packEntriesByDay: keeps each dataset/day whole and fills requests greedily', () => {
	const e = (day: string, datasetId = 'default') => ({ day, datasetId });
	const { batches, oversized } = packEntriesByDay([e('d1'), e('d2'), e('d1'), e('d3'), e('d1', 'other')], 3);
	assert.deepEqual(oversized, []);
	assert.deepEqual(batches.map(b => b.map(x => `${x.datasetId}/${x.day}`)), [['default/d1', 'default/d1', 'default/d2'], ['default/d3', 'other/d1']]);
	assert.deepEqual(packEntriesByDay([e('big'), e('big'), e('big')], 2).oversized, [{ day: 'big', datasetId: 'default', count: 3 }]);
});

test('uploadRollups: reports failure when the server rejects some entries', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry(), createTestEntry('2024-01-02')];
	
	// Mock response with validation errors
	mockFetchResponse = new Response(JSON.stringify({
		uploaded: 1,
		errors: ['Entry 1 invalid', 'Entry 2 invalid']
	}), {
		status: 200,
		statusText: 'OK'
	});
	
	const warnMsgs: string[] = [];
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	// A 2xx is not proof the data landed — a partial store is a failed sync.
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 1); // Only 1 uploaded
	assert.ok(warnMsgs.some(msg => msg.includes('server rejected')));
	assert.ok(warnMsgs.some(msg => msg.includes('stored 1 of 2')));
});

test('uploadRollups: reports failure when the server stores nothing despite HTTP 200', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry(), createTestEntry('2024-01-02')];
	
	// The real server answers 200 with uploaded: 0 when a dataset transaction
	// rolls back, which used to be reported as a successful sync.
	mockFetchResponse = new Response(JSON.stringify({
		uploaded: 0,
		errors: ['Dataset "default": database is locked']
	}), {
		status: 200,
		statusText: 'OK'
	});
	
	const warnMsgs: string[] = [];
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 0);
	assert.ok(result.message.includes('database is locked'));
	assert.ok(warnMsgs.some(msg => msg.includes('stored 0 of 2')));
});

test('uploadRollups: handles server error response', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry()];
	
	// Mock error response
	mockFetchResponse = new Response('Internal Server Error', {
		status: 500,
		statusText: 'Internal Server Error'
	});
	
	const warnMsgs: string[] = [];
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 0);
	assert.ok(warnMsgs.some(msg => msg.includes('HTTP 500')));
});

test('uploadRollups: handles network errors', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry()];
	
	// Mock fetch to throw
	global.fetch = async () => {
		throw new Error('Network error');
	};
	
	const warnMsgs: string[] = [];
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 0);
	assert.ok(warnMsgs.some(msg => msg.includes('Upload failed')));
});

test('uploadRollups: handles empty entries array', async () => {
	const service = new SharingServerUploadService();
	const entries: any[] = [];
	
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		() => {}
	);
	
	assert.equal(result.success, true);
	assert.equal(result.entriesUploaded, 0);
	assert.equal(mockFetchCalls.length, 0); // No calls made for empty array
});

test('uploadRollups: strips trailing slash from endpoint URL', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry()];
	
	await service.uploadRollups(
		'https://server.example.com/',
		'github-token',
		entries,
		() => {},
		() => {}
	);
	
	assert.equal(mockFetchCalls.length, 1);
	const requestUrl = new URL(mockFetchCalls[0].url);
	assert.equal(requestUrl.origin, 'https://server.example.com');
	assert.equal(requestUrl.pathname, '/api/upload');
	assert.ok(!mockFetchCalls[0].url.includes('//api'));
});

test('uploadRollups: sends correct Content-Type header', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry()];
	
	await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		() => {}
	);
	
	assert.equal(mockFetchCalls.length, 1);
	const headers = mockFetchCalls[0].options?.headers as Record<string, string> | undefined;
	assert.equal(headers?.['Content-Type'], 'application/json');
});

test('uploadRollups: sends entries as JSON body', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry('2024-01-01')];
	
	await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		() => {}
	);
	
	assert.equal(mockFetchCalls.length, 1);
	const body = mockFetchCalls[0].body;
	assert.ok(body?.includes('2024-01-01'));
	assert.ok(body?.includes('gpt-4'));
});

test('uploadRollups: reports failure when a 2xx response is not a JSON upload result', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry()];
	
	// A proxy or misconfigured endpoint answering 200 with HTML used to be
	// counted as a full delivery, which is exactly the "healthy sync but no
	// data on the server" symptom this guards against.
	mockFetchResponse = new Response('<html>Not JSON</html>', {
		status: 200,
		statusText: 'OK'
	});
	
	const warnMsgs: string[] = [];
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 0);
	assert.ok(warnMsgs.some(msg => msg.includes('not JSON')));
});

test('uploadRollups: reports failure when a 2xx JSON response has no uploaded count', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry()];
	
	// Valid JSON, but nothing in it says the entries were stored.
	mockFetchResponse = new Response(JSON.stringify({ ok: true }), {
		status: 200,
		statusText: 'OK'
	});
	
	const warnMsgs: string[] = [];
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 0);
	assert.ok(warnMsgs.some(msg => msg.includes('no "uploaded" count')));
});

test('uploadRollups: reports failure when the server reports an impossible uploaded count', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry()];
	
	// An inflated count would otherwise be clamped back up to a full batch and
	// reported as a complete success.
	mockFetchResponse = new Response(JSON.stringify({ uploaded: 99 }), {
		status: 200,
		statusText: 'OK'
	});
	
	const warnMsgs: string[] = [];
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 0);
	assert.ok(warnMsgs.some(msg => msg.includes('impossible')));
});

test('uploadRollups: reports failure when the uploaded count is not a whole number', async () => {
	const service = new SharingServerUploadService();
	const entries = [createTestEntry(), createTestEntry('2024-01-02')];
	
	mockFetchResponse = new Response(JSON.stringify({ uploaded: 1.5 }), {
		status: 200,
		statusText: 'OK'
	});
	
	const result = await service.uploadRollups(
		'https://server.example.com',
		'github-token',
		entries,
		() => {},
		() => {}
	);
	
	assert.equal(result.success, false);
	assert.equal(result.entriesUploaded, 0);
});

// Test suite for uploadFluencyScore
// ==================================

test('uploadFluencyScore: successful upload', async () => {
	const service = new SharingServerUploadService();
	const score = { score: 0.85, stage: 3 };
	
	const logMsgs: string[] = [];
	const warnMsgs: string[] = [];
	
	const uploaded = await service.uploadFluencyScore(
		'https://server.example.com',
		'github-token',
		score,
		(msg) => logMsgs.push(msg),
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(uploaded, true);
	assert.equal(mockFetchCalls.length, 1);
	assert.ok(mockFetchCalls[0].url.includes('/api/fluency-score'));
	const headers = mockFetchCalls[0].options?.headers as Record<string, string> | undefined;
	assert.ok(headers?.['Authorization']?.includes('Bearer github-token'));
	assert.ok(logMsgs.some(msg => msg.includes('fluency-score upload: ok')));
});

test('uploadFluencyScore: handles server error', async () => {
	const service = new SharingServerUploadService();
	const score = { score: 0.85 };
	
	// Mock error response
	mockFetchResponse = new Response('Bad Request', {
		status: 400,
		statusText: 'Bad Request'
	});
	
	const warnMsgs: string[] = [];
	const uploaded = await service.uploadFluencyScore(
		'https://server.example.com',
		'github-token',
		score,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(uploaded, false);
	assert.ok(warnMsgs.some(msg => msg.includes('HTTP 400')));
});

test('uploadFluencyScore: handles network error', async () => {
	const service = new SharingServerUploadService();
	const score = { score: 0.85 };
	
	// Mock fetch to throw
	global.fetch = async () => {
		throw new Error('Network failure');
	};
	
	const warnMsgs: string[] = [];
	const uploaded = await service.uploadFluencyScore(
		'https://server.example.com',
		'github-token',
		score,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(uploaded, false);
	assert.ok(warnMsgs.some(msg => msg.includes('failed')));
});

test('uploadFluencyScore: reports failure when a 2xx response does not confirm the score was stored', async () => {
	const service = new SharingServerUploadService();
	const score = { score: 0.85 };
	
	// A proxy or misconfigured endpoint answering 200 without the server's
	// { ok: true } payload is not evidence the score landed.
	mockFetchResponse = new Response('<html>Logged in</html>', {
		status: 200,
		statusText: 'OK'
	});
	
	const warnMsgs: string[] = [];
	const uploaded = await service.uploadFluencyScore(
		'https://server.example.com',
		'github-token',
		score,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(uploaded, false);
	assert.ok(warnMsgs.some(msg => msg.includes('not JSON')));
});

test('uploadFluencyScore: reports failure when a 2xx JSON response omits ok:true', async () => {
	const service = new SharingServerUploadService();
	const score = { score: 0.85 };
	
	mockFetchResponse = new Response(JSON.stringify({ queued: true }), {
		status: 200,
		statusText: 'OK'
	});
	
	const warnMsgs: string[] = [];
	const uploaded = await service.uploadFluencyScore(
		'https://server.example.com',
		'github-token',
		score,
		() => {},
		(msg) => warnMsgs.push(msg)
	);
	
	assert.equal(uploaded, false);
	assert.ok(warnMsgs.some(msg => msg.includes('did not confirm')));
});

test('uploadFluencyScore: strips trailing slash from endpoint URL', async () => {
	const service = new SharingServerUploadService();
	const score = { score: 0.85 };
	
	await service.uploadFluencyScore(
		'https://server.example.com/',
		'github-token',
		score,
		() => {},
		() => {}
	);
	
	assert.equal(mockFetchCalls.length, 1);
	const calledUrl = new URL(mockFetchCalls[0].url);
	assert.equal(calledUrl.origin, 'https://server.example.com');
	assert.equal(calledUrl.pathname, '/api/fluency-score');
});

test('uploadFluencyScore: sends score as JSON body', async () => {
	const service = new SharingServerUploadService();
	const score = { score: 0.85, stage: 3 };
	
	await service.uploadFluencyScore(
		'https://server.example.com',
		'github-token',
		score,
		() => {},
		() => {}
	);
	
	assert.equal(mockFetchCalls.length, 1);
	const body = mockFetchCalls[0].body;
	assert.ok(body?.includes('0.85'));
	assert.ok(body?.includes('3'));
});
