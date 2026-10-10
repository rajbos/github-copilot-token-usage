import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createPersistedViewState, type StateStorage } from '../../../src/webview/shared/persistedViewState';

function memoryStorage(): StateStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

test('state written by one instance is read back by a new one (panel re-opened)', () => {
	const storage = memoryStorage();
	createPersistedViewState<{ editorListCollapsed: boolean }>(storage, 'webview-state:/chart').setState({ editorListCollapsed: true });
	const reopened = createPersistedViewState<{ editorListCollapsed: boolean }>(storage, 'webview-state:/chart');
	assert.deepEqual(reopened.getState(), { editorListCollapsed: true });
});

test('state is isolated per key so panels do not share state', () => {
	const storage = memoryStorage();
	createPersistedViewState<number>(storage, 'webview-state:/chart').setState(1);
	assert.equal(createPersistedViewState<number>(storage, 'webview-state:/usage').getState(), undefined);
});

test('missing storage, corrupt JSON and throwing storage degrade to no state', () => {
	assert.equal(createPersistedViewState(undefined, 'k').getState(), undefined);
	createPersistedViewState(undefined, 'k').setState({ a: 1 });
	const storage = memoryStorage();
	storage.data.set('k', '{not json');
	assert.equal(createPersistedViewState(storage, 'k').getState(), undefined);
	const throwing: StateStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
	const state = createPersistedViewState(throwing, 'k');
	assert.equal(state.getState(), undefined);
	assert.doesNotThrow(() => state.setState({ a: 1 }));
});
