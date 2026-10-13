/**
 * VS Code implementations of the editor-host services the shared `src/` modules
 * take as injected dependencies. `src/` itself never imports `vscode`; the
 * extension host builds these once and passes them in (see extension.ts).
 */
import * as vscode from 'vscode';
import type { SessionDiscoveryDeps } from '../../src/sessionDiscovery';
import type { WindsurfHost } from '../../src/windsurf';

export function createWindsurfHost(): WindsurfHost {
	return {
		getAppName: () => vscode.env.appName,
		getExtension: (id) => vscode.extensions.getExtension(id),
		isEnabled: () => vscode.workspace.getConfiguration('aiEngineeringFluency').get<boolean>('windsurf.enabled', true),
	};
}

export function createSessionDiscoveryHost(): Pick<SessionDiscoveryDeps, 'getConfiguredSampleDataDirectory' | 'getExtensionStatus'> {
	return {
		getConfiguredSampleDataDirectory: () =>
			vscode.workspace.getConfiguration('aiEngineeringFluency').get<string>('sampleDataDirectory'),
		getExtensionStatus: (id) => vscode.extensions.getExtension(id),
	};
}
