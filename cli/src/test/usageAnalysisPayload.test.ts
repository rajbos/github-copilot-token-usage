import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createUsageAnalysisPayload } from '../commands/payloads';
import type { UsageAnalysisStats } from '../../../src/types';

test('usage-analysis payload passes the optional autonomyUsage field through unchanged', () => {
	const autonomyUsage = { autonomous: 3, supervised: 2, plan: 1, other: 0 };
	const stats = { today: { autonomyUsage }, last30Days: {}, month: {} } as unknown as UsageAnalysisStats;
	const payload = createUsageAnalysisPayload(stats, new Date('2026-10-07T00:00:00Z')) as any;
	assert.deepEqual(payload.today.autonomyUsage, autonomyUsage);
	assert.equal(payload.last30Days.autonomyUsage, undefined);
});
