import './vscode-shim-register';
import test from 'node:test';
import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';
import { AzureNamedKeyCredential } from '@azure/data-tables';
import { StorageSharedKeyCredential } from '@azure/storage-blob';

import { CredentialService } from '../../src/backend/services/credentialService';

const makeContext = () => {
	const store = new Map<string, string>();
	return {
		secrets: {
			async get(key: string) {
				return store.get(key);
			},
			async store(key: string, value: string) {
				store.set(key, value);
			},
			async delete(key: string) {
				store.delete(key);
			}
		}
	} as unknown as vscode.ExtensionContext;
};

const sharedKeySettings = { authMode: 'sharedKey', storageAccount: 'sa' } as any;

test('getBackendDataPlaneCredentials returns Entra credential without secrets', async () => {
	const svc = new CredentialService(makeContext());
	const creds = await svc.getBackendDataPlaneCredentials({ authMode: 'entraId', storageAccount: 'sa' } as any);
	assert.ok(creds);
	assert.equal(creds?.secretsToRedact.length, 0);
});

test('getBackendDataPlaneCredentials returns undefined when user cancels shared key prompt', async () => {
	(vscode as any).__mock.reset();
	const svc = new CredentialService(makeContext());
	const creds = await svc.getBackendDataPlaneCredentials(sharedKeySettings);
	assert.equal(creds, undefined);
});

test('getBackendDataPlaneCredentials prompts, stores, and returns shared key credentials', async () => {
	(vscode as any).__mock.reset();
	(vscode as any).__mock.setNextPick('Set Shared Key');
	const windowMock = vscode.window as unknown as { showInputBox: typeof vscode.window.showInputBox };
	windowMock.showInputBox = async () => 'shh-key';
	const svc = new CredentialService(makeContext());
	const creds = await svc.getBackendDataPlaneCredentials(sharedKeySettings);
	assert.ok(creds);
	assert.equal(creds?.secretsToRedact[0], 'shh-key');
	assert.ok(creds?.tableCredential instanceof AzureNamedKeyCredential);
	assert.ok(creds?.blobCredential instanceof StorageSharedKeyCredential);
});

test('getBackendDataPlaneCredentialsOrThrow throws when shared key remains unset', async () => {
	(vscode as any).__mock.reset();
	const svc = new CredentialService(makeContext());
	await assert.rejects(() => svc.getBackendDataPlaneCredentialsOrThrow(sharedKeySettings));
});

test('getBackendSecretsToRedactForError returns stored key when available', async () => {
	(vscode as any).__mock.reset();
	const ctx = makeContext();
	const svc = new CredentialService(ctx);
	await ctx.secrets.store('copilotTokenTracker.backend.storageSharedKey:sa', 'secret');
	const secrets = await svc.getBackendSecretsToRedactForError(sharedKeySettings);
	assert.deepEqual(secrets, ['secret']);
});

test('getStoredStorageSharedKey short-circuits when storage account is empty', async () => {
	(vscode as any).__mock.reset();
	const svc = new CredentialService(makeContext());
	const key = await svc.getStoredStorageSharedKey('');
	assert.equal(key, undefined);
});

test('setStoredStorageSharedKey throws when SecretStorage is unavailable', async () => {
	(vscode as any).__mock.reset();
	const svc = new CredentialService(undefined as any);
	await assert.rejects(() => svc.setStoredStorageSharedKey('sa', 'k'), /SecretStorage is unavailable/);
});

test('getBackendSecretsToRedactForError falls back to empty list on failures', async () => {
	(vscode as any).__mock.reset();
	const ctx = {
		secrets: {
			get() {
				throw new Error('boom');
			}
		}
	} as unknown as vscode.ExtensionContext;
	const svc = new CredentialService(ctx);
	const secrets = await svc.getBackendSecretsToRedactForError(sharedKeySettings);
	assert.deepEqual(secrets, []);
});

test('getStoredStorageSharedKey throws when context is undefined', async () => {
	(vscode as any).__mock.reset();
	const svc = new CredentialService(undefined as any);
	await assert.rejects(() => svc.getStoredStorageSharedKey('sa'), /Extension context/);
});

test('clearStoredStorageSharedKey deletes the stored key', async () => {
	(vscode as any).__mock.reset();
	const ctx = makeContext();
	const svc = new CredentialService(ctx);
	await ctx.secrets.store('copilotTokenTracker.backend.storageSharedKey:sa', 'mykey');
	// Verify it exists
	const before = await svc.getStoredStorageSharedKey('sa');
	assert.equal(before, 'mykey');
	// Delete it
	await svc.clearStoredStorageSharedKey('sa');
	// Verify it's gone
	const after = await svc.getStoredStorageSharedKey('sa');
	assert.equal(after, undefined);
});

test('clearStoredStorageSharedKey throws when SecretStorage is unavailable', async () => {
	(vscode as any).__mock.reset();
	const svc = new CredentialService(undefined as any);
	await assert.rejects(() => svc.clearStoredStorageSharedKey('sa'), /SecretStorage is unavailable/);
});

test('getBackendDataPlaneCredentials returns existing shared key without prompting', async () => {
	(vscode as any).__mock.reset();
	const ctx = makeContext();
	await ctx.secrets.store('copilotTokenTracker.backend.storageSharedKey:sa', 'preexisting-key');
	const svc = new CredentialService(ctx);
	const creds = await svc.getBackendDataPlaneCredentials(sharedKeySettings);
	assert.ok(creds);
	assert.equal(creds?.secretsToRedact[0], 'preexisting-key');
	assert.ok(creds?.tableCredential instanceof AzureNamedKeyCredential);
	assert.ok(creds?.blobCredential instanceof StorageSharedKeyCredential);
});
