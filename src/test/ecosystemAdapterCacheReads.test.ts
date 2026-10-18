import test from 'node:test';
import * as assert from 'node:assert/strict';
import { listAdaptersWithoutCacheReads } from '../ecosystemAdapter';
import type { IEcosystemAdapter } from '../ecosystemAdapter';
import { ClaudeCodeAdapter } from '../adapters/claudeCodeAdapter';
import { CopilotChatAdapter } from '../adapters/copilotChatAdapter';

const fake = (displayName: string, reportsCacheReads?: boolean): IEcosystemAdapter =>
	({ id: displayName, displayName, reportsCacheReads } as unknown as IEcosystemAdapter);

test('listAdaptersWithoutCacheReads: unset and false count as not reporting', () => {
	assert.deepEqual(listAdaptersWithoutCacheReads([fake('A', true), fake('B', false), fake('C')]), ['B', 'C']);
});

test('adapter flags: Claude Code reports cache reads, Copilot Chat does not', () => {
	assert.equal(new ClaudeCodeAdapter({} as never).reportsCacheReads, true);
	assert.equal(new CopilotChatAdapter().reportsCacheReads, false);
});
