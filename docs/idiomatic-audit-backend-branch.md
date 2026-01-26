# Idiomatic Audit: Backend Branch

**Date:** January 26, 2026  
**Branch:** `backend`  
**Scope:** Modified TypeScript source files in backend branch vs. main  
**Technologies:** VS Code Extension API, TypeScript, Azure SDK for JavaScript

---

## Executive Summary

This audit reviews the idiomatic quality of the backend branch implementation against best practices for VS Code extension development, TypeScript, and Azure SDK usage. The codebase demonstrates strong architectural separation, good type safety, and proper error handling patterns. However, there are opportunities to improve VS Code extension lifecycle management, async error handling, and resource cleanup.

**Overall Assessment:** 🟡 Good with room for improvement  
**High Priority Issues:** 3  
**Medium Priority Issues:** 7  
**Low Priority Issues:** 5  

---

## 1. Positive Findings ✅

### 1.1 Excellent Service Separation
**Files:** `src/backend/facade.ts`, `src/backend/services/*.ts`

The codebase demonstrates excellent architectural separation with a clear facade pattern and service-oriented architecture:
- `CredentialService` handles authentication in isolation
- `DataPlaneService` manages Azure Table Storage operations
- `SyncService` handles background synchronization
- `QueryService` manages data retrieval and caching

This makes the code testable, maintainable, and follows single-responsibility principle.

### 1.2 Strong Type Safety with Discriminated Unions
**Files:** `src/backend/types.ts`, `src/backend/settings.ts`

Excellent use of TypeScript discriminated unions and type guards:
```typescript
export type BackendSharingProfile = 'off' | 'soloFull' | 'teamAnonymized' | 'teamPseudonymous' | 'teamIdentified';
export type BackendAuthMode = 'entraId' | 'sharedKey';
```

These literal types prevent invalid states and enable exhaustive checking.

### 1.3 Proper Error Handling with Custom Error Types
**Files:** `src/utils/errors.ts`

Well-designed custom error hierarchy:
```typescript
export class BackendError extends Error
export class BackendConfigError extends BackendError
export class BackendAuthError extends BackendError
export class BackendSyncError extends BackendError
```

Includes secret redaction in `safeStringifyError()` to prevent credential leaks in logs.

### 1.4 Secure Credential Management
**Files:** `src/backend/services/credentialService.ts`

Proper use of VS Code `SecretStorage` API for storing sensitive data:
```typescript
await this.context.secrets.store(this.getSharedKeySecretStorageKey(storageAccount), sharedKey);
```

Credentials are stored per-device and never logged or exposed in errors.

### 1.5 Azure SDK Best Practices
**Files:** `src/backend/services/credentialService.ts`, `src/backend/services/dataPlaneService.ts`

Correct use of Azure identity patterns:
- `DefaultAzureCredential` for Entra ID authentication
- `AzureNamedKeyCredential` for shared key authentication
- Proper retry logic with exponential backoff in `upsertEntityWithRetry()`

---

## 2. High Priority Issues 🔴

### 2.1 Missing Disposable Resource Cleanup in Webview Panels
**Severity:** High  
**Files:** `src/backend/configPanel.ts`

**Issue:** The `BackendConfigPanel` creates a webview panel but doesn't properly track and dispose of message listeners.

**Current Code:**
```typescript
this.panel.onDidDispose(() => this.handleDispose());
this.panel.webview.onDidReceiveMessage(async (message) => this.handleMessage(message));
```

**Problem:** Event listeners from `onDidReceiveMessage` are not tracked in `context.subscriptions`, which can cause memory leaks.

**Recommended Fix:**
```typescript
export class BackendConfigPanel implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];

	public async show(): Promise<void> {
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(/*...*/);
			this.disposables.push(
				this.panel.onDidDispose(() => this.handleDispose()),
				this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message))
			);
		}
	}

	public dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
		this.panel?.dispose();
	}
}
```

**Reference:** VS Code Extension API best practice - all disposables should be tracked and disposed.

---

### 2.2 Unhandled Promise Rejections in Background Sync
**Severity:** High  
**Files:** `src/backend/services/syncService.ts`

**Issue:** Background sync timer uses `catch()` but doesn't properly handle consecutive failures.

**Current Code:**
```typescript
this.backendSyncInterval = setInterval(() => {
	this.syncToBackendStore(false, settings, isConfigured).catch((e) => {
		this.deps.warn(`Backend sync timer failed: ${e?.message ?? e}`);
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
			this.deps.warn(`Backend sync: stopping timer after ${this.MAX_CONSECUTIVE_FAILURES} consecutive failures`);
			this.stopTimer();
		}
	});
}, intervalMs);
```

**Problem:** 
1. Errors are logged but not reported to the user
2. No telemetry for debugging production issues
3. Silent failure mode leaves users unaware of sync problems

**Recommended Fix:**
```typescript
this.backendSyncInterval = setInterval(() => {
	this.syncToBackendStore(false, settings, isConfigured).catch((e) => {
		this.deps.warn(`Backend sync timer failed: ${safeStringifyError(e)}`);
		this.consecutiveFailures++;
		
		// Show user-facing warning after first few failures
		if (this.consecutiveFailures === 3) {
			vscode.window.showWarningMessage(
				'Backend sync is experiencing issues. Check the output panel for details.',
				'Show Output'
			).then(choice => {
				if (choice === 'Show Output') {
					// Show output channel
				}
			});
		}
		
		if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
			vscode.window.showErrorMessage(
				'Backend sync stopped after repeated failures. Check your Azure configuration.',
				'Configure Backend'
			);
			this.stopTimer();
		}
	});
}, intervalMs);
```

---

### 2.3 Missing Null Safety for Extension Context
**Severity:** High  
**Files:** `src/backend/facade.ts`, `src/backend/services/credentialService.ts`

**Issue:** Extension context is typed as `vscode.ExtensionContext | undefined` but not all code paths check for undefined.

**Current Code (credentialService.ts):**
```typescript
async getStoredStorageSharedKey(storageAccount: string): Promise<string | undefined> {
	if (!storageAccount) {
		return undefined;
	}
	return (await this.context?.secrets.get(this.getSharedKeySecretStorageKey(storageAccount))) ?? undefined;
}
```

**Problem:** Using optional chaining (`this.context?.secrets`) silently returns undefined if context is missing. This can hide configuration issues.

**Recommended Fix:**
```typescript
async getStoredStorageSharedKey(storageAccount: string): Promise<string | undefined> {
	if (!storageAccount) {
		return undefined;
	}
	if (!this.context?.secrets) {
		throw new BackendConfigError('Extension context is not available. This should never happen in a running extension.');
	}
	return (await this.context.secrets.get(this.getSharedKeySecretStorageKey(storageAccount))) ?? undefined;
}
```

**Alternative:** Use non-null assertion in constructor if context is guaranteed:
```typescript
constructor(context: vscode.ExtensionContext) {
	this.context = context; // Not optional
}
```

---

## 3. Medium Priority Issues 🟡

### 3.1 Inconsistent Error Handling Patterns
**Severity:** Medium  
**Files:** `src/backend/commands.ts`, `src/backend/facade.ts`, `src/backend/integration.ts`

**Issue:** Mix of try-catch blocks, `.catch()` handlers, and error propagation.

**Current Code (commands.ts):**
```typescript
async handleConfigureBackend(): Promise<void> {
	try {
		await this.facade.configureBackendWizard();
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		showBackendError(ErrorMessages.unable('configure backend', `Try the wizard again. Details: ${details}`));
	}
}
```

**Problem:** Inconsistent error handling makes it hard to predict behavior. Some methods throw, others catch and show UI.

**Recommended Fix:** Establish a consistent pattern:
1. Service layer methods throw typed errors
2. Facade layer catches and optionally logs
3. Command layer always catches and shows user-facing messages

```typescript
// Service layer - throw typed errors
async someServiceMethod(): Promise<void> {
	throw new BackendAuthError('Authentication failed', originalError);
}

// Facade layer - log and optionally rethrow
async someFacadeMethod(): Promise<void> {
	try {
		await this.service.someServiceMethod();
	} catch (error) {
		this.deps.warn(`Service failed: ${safeStringifyError(error)}`);
		throw error; // or wrap it
	}
}

// Command layer - always show user message
async handleCommand(): Promise<void> {
	try {
		await this.facade.someFacadeMethod();
	} catch (error) {
		showBackendError(ErrorMessages.fromError(error));
	}
}
```

---

### 3.2 Tight Coupling to VS Code APIs in Service Layer
**Severity:** Medium  
**Files:** `src/backend/services/syncService.ts`, `src/backend/services/dataPlaneService.ts`

**Issue:** Service classes directly import and use `vscode.*` APIs, making them harder to test.

**Current Code (dataPlaneService.ts):**
```typescript
await tableClient.upsertEntity(probeEntity, 'Replace');
```

**Problem:** Direct Azure SDK calls in service layer make unit testing require mocking the entire Azure SDK.

**Recommended Fix:** Introduce interfaces for external dependencies:
```typescript
export interface TableClientLike {
	upsertEntity(entity: any, mode: 'Replace' | 'Merge'): Promise<void>;
	deleteEntity(partitionKey: string, rowKey: string): Promise<void>;
}

export class DataPlaneService {
	constructor(
		private createTableClientFn: (settings: BackendSettings, credential: any) => TableClientLike,
		// ... other deps
	) {}
}
```

This allows injecting test doubles for unit tests.

---

### 3.3 Missing Input Validation for User-Provided Data
**Severity:** Medium  
**Files:** `src/backend/configurationFlow.ts`, `src/backend/configPanel.ts`

**Issue:** User input validation happens in webview JavaScript but not server-side.

**Current Code (configPanel.ts - webview HTML):**
```javascript
const aliasRegex = new RegExp('^[A-Za-z0-9][A-Za-z0-9_-]*$');
function validateLocal(draft) {
	const errors = {};
	if (!draft.datasetId || !draft.datasetId.trim()) errors.datasetId = 'Required';
	else if (!aliasRegex.test(draft.datasetId.trim())) errors.datasetId = 'Use letters, numbers, dashes, underscores';
	// ...
}
```

**Problem:** Validation only happens in the webview. Extension code should never trust client-side validation.

**Recommended Fix:** Duplicate validation in `validateDraft()` in `configurationFlow.ts`:
```typescript
export function validateDraft(draft: BackendConfigDraft): { valid: boolean; errors: Record<string, string> } {
	const errors: Record<string, string> = {};
	
	// Dataset ID validation
	const aliasRegex = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
	if (!draft.datasetId?.trim()) {
		errors.datasetId = 'Dataset ID is required';
	} else if (!aliasRegex.test(draft.datasetId.trim())) {
		errors.datasetId = 'Dataset ID must start with a letter/number and contain only letters, numbers, dashes, and underscores';
	}
	
	// Storage account name validation
	if (draft.enabled && draft.storageAccount) {
		const storageRegex = /^[a-z0-9]{3,24}$/;
		if (!storageRegex.test(draft.storageAccount.trim())) {
			errors.storageAccount = 'Storage account must be 3-24 lowercase letters and numbers';
		}
	}
	
	// ... other validations
	
	return { valid: Object.keys(errors).length === 0, errors };
}
```

---

### 3.4 No Timeout Protection for Azure SDK Calls
**Severity:** Medium  
**Files:** `src/backend/services/dataPlaneService.ts`, `src/backend/services/azureResourceService.ts`

**Issue:** Azure SDK calls can hang indefinitely with no timeout.

**Current Code:**
```typescript
await tableClient.upsertEntity(probeEntity, 'Replace');
```

**Problem:** Network issues can cause indefinite hangs, blocking extension operations.

**Recommended Fix:** Wrap Azure SDK calls with timeout:
```typescript
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => 
			setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
		)
	]);
}

// Usage
await withTimeout(
	tableClient.upsertEntity(probeEntity, 'Replace'),
	30000, // 30 seconds
	'Table entity upsert'
);
```

---

### 3.5 Webview Security: Missing CSP Nonce Validation
**Severity:** Medium  
**Files:** `src/backend/configPanel.ts`, `src/webview/*/main.ts`

**Issue:** Webview HTML includes inline scripts with nonce, but the nonce generation uses `Math.random()`.

**Current Code (configPanel.ts):**
```typescript
const nonce = Math.random().toString(36).slice(2);
```

**Problem:** `Math.random()` is not cryptographically secure. For CSP nonces, you should use a secure random generator.

**Recommended Fix:**
```typescript
import * as crypto from 'crypto';

function generateNonce(): string {
	return crypto.randomBytes(16).toString('base64');
}

// Usage in renderHtml()
const nonce = generateNonce();
```

---

### 3.6 Missing Progress Reporting for Long Operations
**Severity:** Medium  
**Files:** `src/backend/commands.ts`, `src/backend/facade.ts`

**Issue:** Some long-running operations don't report progress.

**Current Code (commands.ts):**
```typescript
async handleSyncBackendNow(): Promise<void> {
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Syncing to backend...',
			cancellable: false
		},
		async () => {
			await this.facade.syncToBackendStore(true);
		}
	);
}
```

**Problem:** Good use of `withProgress`, but not consistent across all long operations.

**Recommended Fix:** Ensure all long operations (> 1 second) use progress reporting:
```typescript
async testConnectionFromDraft(draft: BackendConfigDraft): Promise<{ ok: boolean; message: string }> {
	return await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Testing connection to Azure Storage...',
			cancellable: false
		},
		async (progress) => {
			progress.report({ increment: 25, message: 'Acquiring credentials...' });
			const creds = await this.credentialService.getBackendDataPlaneCredentials(settings);
			
			progress.report({ increment: 50, message: 'Connecting to storage...' });
			await this.dataPlaneService.validateAccess(settings, creds.tableCredential);
			
			progress.report({ increment: 100, message: 'Success!' });
			return { ok: true, message: SuccessMessages.connected() };
		}
	);
}
```

---

### 3.7 Potential Race Condition in Config Panel State Updates
**Severity:** Medium  
**Files:** `src/backend/configPanel.ts`

**Issue:** Message handlers update state asynchronously, but there's no locking mechanism.

**Current Code:**
```typescript
private async handleSave(draft: BackendConfigDraft): Promise<void> {
	const result = await this.callbacks.onSave(draft);
	this.dirty = false;
	this.postState(result.state, result.errors, result.message);
}
```

**Problem:** If user clicks "Save" twice quickly, both handlers run concurrently and can cause inconsistent state.

**Recommended Fix:** Add a simple locking mechanism:
```typescript
export class BackendConfigPanel implements vscode.Disposable {
	private operationInProgress = false;

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		if (this.operationInProgress) {
			throw new Error('Another operation is in progress. Please wait.');
		}
		this.operationInProgress = true;
		try {
			return await operation();
		} finally {
			this.operationInProgress = false;
		}
	}

	private async handleSave(draft: BackendConfigDraft): Promise<void> {
		await this.withLock(async () => {
			const result = await this.callbacks.onSave(draft);
			this.dirty = false;
			this.postState(result.state, result.errors, result.message);
		});
	}
}
```

---

## 4. Low Priority Issues 🟢

### 4.1 Magic Numbers in Configuration
**Severity:** Low  
**Files:** `src/backend/commands.ts`, `src/backend/services/syncService.ts`

**Issue:** Hardcoded magic numbers without named constants.

**Current Code:**
```typescript
private readonly MANUAL_SYNC_COOLDOWN_MS = 5000; // 5 seconds
```

**Recommended Fix:** Move to constants file:
```typescript
// constants.ts
export const MANUAL_SYNC_COOLDOWN_MS = 5_000; // 5 seconds (use _ for readability)
export const MAX_CONSECUTIVE_SYNC_FAILURES = 5;
export const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
```

---

### 4.2 Verbose Type Annotations Where Inference Works
**Severity:** Low  
**Files:** Multiple files

**Issue:** Redundant type annotations where TypeScript can infer the type.

**Current Code:**
```typescript
const errors: Record<string, string> = {};
```

**Recommended Fix:**
```typescript
const errors = {} as Record<string, string>; // or just {} if adding properties later
```

**Note:** This is a stylistic preference. Explicit types improve readability but can be verbose.

---

### 4.3 Missing JSDoc for Public API Methods
**Severity:** Low  
**Files:** `src/backend/facade.ts`, `src/backend/services/*.ts`

**Issue:** Some public methods lack JSDoc comments.

**Recommended Fix:** Add JSDoc for all public methods:
```typescript
/**
 * Synchronizes local session data to Azure backend storage.
 * 
 * @param force - If true, forces sync even if recently synced
 * @returns Promise that resolves when sync completes
 * @throws {BackendSyncError} If sync fails due to network or auth issues
 */
public async syncToBackendStore(force: boolean): Promise<void> {
	// ...
}
```

---

### 4.4 Inconsistent String Formatting
**Severity:** Low  
**Files:** Multiple files

**Issue:** Mix of template literals and string concatenation.

**Current Code:**
```typescript
ErrorMessages.unable('configure backend', `Try the wizard again. Details: ${details}`)
```

**Recommended Fix:** Consistently use template literals for all string formatting:
```typescript
`Failed to configure backend: ${details}. Try the wizard again.`
```

---

### 4.5 Missing Readonly Modifiers for Immutable Properties
**Severity:** Low  
**Files:** Service classes

**Issue:** Class properties that should be readonly are not marked as such.

**Current Code:**
```typescript
export class CredentialService {
	constructor(private context: vscode.ExtensionContext | undefined) {}
}
```

**Recommended Fix:**
```typescript
export class CredentialService {
	constructor(private readonly context: vscode.ExtensionContext | undefined) {}
}
```

---

## 5. Proposed Tasks for Fixes

### High Priority Tasks
1. **Task: Add Disposable Tracking to Config Panel**
   - File: `src/backend/configPanel.ts`
   - Estimated effort: 30 minutes
   - Add `disposables` array and track all event listeners

2. **Task: Improve Background Sync Error Reporting**
   - File: `src/backend/services/syncService.ts`
   - Estimated effort: 1 hour
   - Add user-facing warnings after failures
   - Implement progressive error reporting

3. **Task: Add Null Safety Checks for Extension Context**
   - Files: `src/backend/services/credentialService.ts`, `src/backend/facade.ts`
   - Estimated effort: 1 hour
   - Replace optional chaining with explicit checks and errors
   - Or make context non-optional if guaranteed

### Medium Priority Tasks
4. **Task: Standardize Error Handling Patterns**
   - Files: Multiple backend files
   - Estimated effort: 2-3 hours
   - Document error handling conventions
   - Refactor inconsistent patterns

5. **Task: Add Server-Side Input Validation**
   - Files: `src/backend/configurationFlow.ts`
   - Estimated effort: 1 hour
   - Move all validation logic from webview to extension
   - Add comprehensive validation tests

6. **Task: Add Timeout Protection for Azure SDK Calls**
   - Files: `src/backend/services/dataPlaneService.ts`, `src/backend/services/azureResourceService.ts`
   - Estimated effort: 1-2 hours
   - Create `withTimeout` utility
   - Apply to all Azure SDK calls

7. **Task: Use Crypto-Secure Nonce Generation**
   - Files: `src/backend/configPanel.ts`, webview templates
   - Estimated effort: 15 minutes
   - Replace `Math.random()` with `crypto.randomBytes()`

8. **Task: Add Progress Reporting to Long Operations**
   - Files: `src/backend/facade.ts`, `src/backend/commands.ts`
   - Estimated effort: 1 hour
   - Audit all operations > 1 second
   - Add `withProgress` wrappers

### Low Priority Tasks
9. **Task: Extract Magic Numbers to Constants**
   - Files: Multiple
   - Estimated effort: 30 minutes
   - Create comprehensive constants file

10. **Task: Add JSDoc to Public APIs**
    - Files: All service and facade files
    - Estimated effort: 2 hours
    - Document all public methods with JSDoc

---

## 6. Testing Recommendations

### Unit Test Coverage Gaps
Based on the code review, the following areas need unit tests:
1. `CredentialService` - mock `vscode.SecretStorage`
2. `DataPlaneService` retry logic
3. `SyncService` consecutive failure handling
4. `BackendConfigPanel` state management
5. Input validation in `configurationFlow.ts`

### Integration Test Scenarios
1. Full backend sync flow with mock Azure SDK
2. Credential rotation flow
3. Config panel state persistence
4. Error recovery and retry logic

---

## 7. References

### VS Code Extension Best Practices
- [VS Code Extension API - Webview Guide](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Extension API - Activation Events](https://code.visualstudio.com/api/references/activation-events)
- [VS Code Extension API - Disposables](https://code.visualstudio.com/api/references/vscode-api#Disposable)

### TypeScript Best Practices
- [TypeScript Handbook - Discriminated Unions](https://www.typescriptlang.org/docs/handbook/unions-and-intersections.html)
- [TypeScript Handbook - Type Guards](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [TypeScript Handbook - Error Handling](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-6.html)

### Azure SDK Best Practices
- [Azure SDK for JavaScript - Authentication](https://learn.microsoft.com/azure/developer/javascript/sdk/authentication/overview)
- [Azure SDK for JavaScript - Error Handling](https://learn.microsoft.com/azure/developer/javascript/how-to/with-azure-sdk/error-handling)
- [Azure SDK for JavaScript - Retry Policies](https://learn.microsoft.com/azure/developer/javascript/sdk/retry-policies)

---

## Summary

The backend branch demonstrates a well-architected solution with strong separation of concerns, good type safety, and proper credential management. The main areas for improvement are:

1. **Resource Lifecycle**: Ensure all disposables are properly tracked and cleaned up
2. **Error Handling**: Standardize error handling patterns and improve user-facing error messages
3. **Input Validation**: Never trust client-side validation; always validate server-side
4. **Timeout Protection**: Add timeouts to all Azure SDK calls to prevent hangs
5. **Security**: Use cryptographically secure random for CSP nonces

Implementing the high and medium priority fixes will bring the codebase to production quality and align with VS Code extension and Azure SDK best practices.
