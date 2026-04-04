/**
 * Centralized button configuration for webview navigation.
 * This ensures consistent button IDs, labels, and icons across all webviews.
 */

export type ButtonId = 'btn-refresh' | 'btn-details' | 'btn-chart' | 'btn-usage' | 'btn-diagnostics' | 'btn-maturity' | 'btn-dashboard' | 'btn-level-viewer' | 'btn-environmental';

export interface ButtonConfig {
	id: ButtonId;
	label: string;
	appearance?: 'primary' | 'secondary';
}

/**
 * Navigation button definitions used across all webview panels.
 */
export const BUTTONS: Record<ButtonId, ButtonConfig> = {
	'btn-refresh': {
		id: 'btn-refresh',
		label: '🔄 Refresh',
		appearance: 'primary'
	},
	'btn-details': {
		id: 'btn-details',
		label: '🤖 Details'
	},
	'btn-chart': {
		id: 'btn-chart',
		label: '📈 Chart'
	},
	'btn-usage': {
		id: 'btn-usage',
		label: '📊 Usage Analysis'
	},
	'btn-diagnostics': {
		id: 'btn-diagnostics',
		label: '🔍 Diagnostics'
	},
	'btn-maturity': {
		id: 'btn-maturity',
		label: '🎯 Fluency Score'
	},
	'btn-dashboard': {
		id: 'btn-dashboard',
		label: '📊 Team Dashboard'
  },  
	'btn-level-viewer': {
		id: 'btn-level-viewer',
		label: '🔍 Level Viewer'
	},
	'btn-environmental': {
		id: 'btn-environmental',
		label: '🌿 Environmental Impact'
	}
};

/**
 * Helper function to get button configuration by ID.
 */
export function getButton(id: ButtonId): ButtonConfig {
	return BUTTONS[id];
}

/**
 * Generates an HTML string for a vscode-button element from a button config.
 * Useful for template strings where DOM manipulation isn't available.
 */
export function buttonHtml(id: ButtonId): string {
	const config = BUTTONS[id];
	const appearance = config.appearance ? ` appearance="${config.appearance}"` : '';
	return `<vscode-button id="${config.id}"${appearance}>${config.label}</vscode-button>`;
}
