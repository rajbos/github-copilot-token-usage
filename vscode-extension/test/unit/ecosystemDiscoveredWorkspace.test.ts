import test from 'node:test';
import * as assert from 'node:assert/strict';

import { findWorkspacePathForDiscoveredPath, type IEcosystemAdapter } from '../../../src/ecosystemAdapter';

/** Just enough of an adapter for the discovery-hook lookup. */
function adapter(handles: boolean, lookup?: (file: string) => Promise<string | undefined>): IEcosystemAdapter {
	return {
		handles: () => handles,
		...(lookup ? { getWorkspacePathForDiscoveredPath: lookup } : {}),
	} as unknown as IEcosystemAdapter;
}

test('findWorkspacePathForDiscoveredPath asks adapters that discovered but do not handle the file', async () => {
	const file = '/home/u/.copilot/session-state/abc/events.jsonl';
	const cliAdapter = adapter(false, async f => (f === file ? '/home/u/code/acme-app' : undefined));
	assert.equal(await findWorkspacePathForDiscoveredPath([cliAdapter], file), '/home/u/code/acme-app');
});

test('findWorkspacePathForDiscoveredPath skips the handling adapter, adapters without the hook, and failures', async () => {
	const file = '/x/events.jsonl';
	const handling = adapter(true, async () => '/wrong/handling-adapter');
	const noHook = adapter(false);
	const failing = adapter(false, async () => { throw new Error('boom'); });
	const answering = adapter(false, async () => '/right');
	assert.equal(await findWorkspacePathForDiscoveredPath([handling, noHook, failing, answering], file), '/right');
	assert.equal(await findWorkspacePathForDiscoveredPath([handling, noHook, failing], file), undefined);
	assert.equal(await findWorkspacePathForDiscoveredPath([], file), undefined);
});
