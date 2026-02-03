// Diagnostics Report webview with tabbed interface
import { buttonHtml } from '../shared/buttonConfig';

// Constants
const LOADING_PLACEHOLDER = 'Loading...';
const SESSION_FILES_SECTION_REGEX = /Session File Locations \(first 20\):[\s\S]*?(?=\n\s*\n|={70})/;
const LOADING_MESSAGE = `⏳ Loading diagnostic data...

This may take a few moments depending on the number of session files.
The view will automatically update when data is ready.`;

type ContextReferenceUsage = {
	file: number;
	selection: number;
	symbol: number;
	codebase: number;
	workspace: number;
	terminal: number;
	vscode: number;
};

type SessionFileDetails = {
	file: string;
	size: number;
	modified: string;
	interactions: number;
	contextReferences: ContextReferenceUsage;
	firstInteraction: string | null;
	lastInteraction: string | null;
	editorSource: string;
	editorRoot?: string;
	editorName?: string;
	title?: string;
};

type CacheInfo = {
	size: number;
	sizeInMB: number;
	lastUpdated: string | null;
	location: string;
	storagePath?: string | null;
};

type BackendStorageInfo = {
	enabled: boolean;
	isConfigured: boolean;
	storageAccount: string;
	subscriptionId: string;
	resourceGroup: string;
	aggTable: string;
	eventsTable: string;
	authMode: string;
	sharingProfile: string;
	lastSyncTime: string | null;
	deviceCount: number;
	sessionCount: number;
	recordCount: number | null;
};

type DiagnosticsData = {
	report: string;
	sessionFiles: { file: string; size: number; modified: string }[];
	detailedSessionFiles?: SessionFileDetails[];
	cacheInfo?: CacheInfo;
	backendStorageInfo?: BackendStorageInfo;
};

type DiagnosticsViewState = {
	activeTab?: string;
};

declare function acquireVsCodeApi<TState = DiagnosticsViewState>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

declare global {
	interface Window { __INITIAL_DIAGNOSTICS__?: DiagnosticsData; }
}

const vscode = acquireVsCodeApi<DiagnosticsViewState>();
const initialData = window.__INITIAL_DIAGNOSTICS__;

// Sorting and filtering state
let currentSortColumn: 'firstInteraction' | 'lastInteraction' = 'lastInteraction';
let currentSortDirection: 'asc' | 'desc' = 'desc';
let currentEditorFilter: string | null = null; // null = show all

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function removeSessionFilesSection(reportText: string): string {
	return reportText.replace(SESSION_FILES_SECTION_REGEX, '');
}

function formatDate(isoString: string | null): string {
	if (!isoString) { return 'N/A'; }
	try {
		return new Date(isoString).toLocaleString();
	} catch {
		return isoString;
	}
}

function getTimeSince(isoString: string): string {
	try {
		const now = Date.now();
		const then = new Date(isoString).getTime();
		const diffMs = now - then;
		
		if (diffMs < 0) { return 'Just now'; }
		
		const seconds = Math.floor(diffMs / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);
		
		if (days > 0) { return `${days} day${days !== 1 ? 's' : ''} ago`; }
		if (hours > 0) { return `${hours} hour${hours !== 1 ? 's' : ''} ago`; }
		if (minutes > 0) { return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`; }
		return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
	} catch {
		return 'Unknown';
	}
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) { return `${bytes} B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sanitizeNumber(value: number | undefined | null): string {
	if (value === undefined || value === null) {
		return '0';
	}
	return value.toString();
}

function getTotalContextRefs(refs: ContextReferenceUsage): number {
	return refs.file + refs.selection + refs.symbol + refs.codebase +
		refs.workspace + refs.terminal + refs.vscode;
}

function getContextRefsSummary(refs: ContextReferenceUsage): string {
	const parts: string[] = [];
	if (refs.file > 0) { parts.push(`#file: ${refs.file}`); }
	if (refs.selection > 0) { parts.push(`#sel: ${refs.selection}`); }
	if (refs.symbol > 0) { parts.push(`#sym: ${refs.symbol}`); }
	if (refs.codebase > 0) { parts.push(`#cb: ${refs.codebase}`); }
	if (refs.workspace > 0) { parts.push(`@ws: ${refs.workspace}`); }
	if (refs.terminal > 0) { parts.push(`@term: ${refs.terminal}`); }
	if (refs.vscode > 0) { parts.push(`@vsc: ${refs.vscode}`); }
	return parts.length > 0 ? parts.join(', ') : 'None';
}

function getFileName(filePath: string): string {
	const parts = filePath.split(/[/\\]/);
	return parts[parts.length - 1];
}

function getEditorIcon(editor: string): string {
	const lower = editor.toLowerCase();
	if (lower.includes('cursor')) { return '🖱️'; }
	if (lower.includes('insiders')) { return '💚'; }
	if (lower.includes('vscodium')) { return '🔵'; }
	if (lower.includes('windsurf')) { return '🏄'; }
	if (lower.includes('vs code') || lower.includes('vscode')) { return '💙'; }
	return '📝';
}

function sortSessionFiles(files: SessionFileDetails[]): SessionFileDetails[] {
	return [...files].sort((a, b) => {
		const aVal = currentSortColumn === 'firstInteraction' ? a.firstInteraction : a.lastInteraction;
		const bVal = currentSortColumn === 'firstInteraction' ? b.firstInteraction : b.lastInteraction;
		
		// Handle null values - push them to the end
		if (!aVal && !bVal) { return 0; }
		if (!aVal) { return 1; }
		if (!bVal) { return -1; }
		
		const aTime = new Date(aVal).getTime();
		const bTime = new Date(bVal).getTime();
		
		return currentSortDirection === 'desc' ? bTime - aTime : aTime - bTime;
	});
}

function getSortIndicator(column: 'firstInteraction' | 'lastInteraction'): string {
	if (currentSortColumn !== column) { return ''; }
	return currentSortDirection === 'desc' ? ' ▼' : ' ▲';
}

function getEditorStats(files: SessionFileDetails[]): { [key: string]: { count: number; interactions: number } } {
	const stats: { [key: string]: { count: number; interactions: number } } = {};
	for (const sf of files) {
		const editor = sf.editorSource || 'Unknown';
		if (!stats[editor]) { stats[editor] = { count: 0, interactions: 0 }; }
		stats[editor].count++;
		stats[editor].interactions += sf.interactions;
	}
	return stats;
}

function safeText(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'string') {
		// Use existing HTML escaping to avoid XSS when inserting into innerHTML.
		return escapeHtml(value);
	}
	return String(value);
}

function renderSessionTable(detailedFiles: SessionFileDetails[], isLoading: boolean = false): string {
	if (isLoading) {
		return `
			<div class="loading-state">
				<div class="loading-spinner">⏳</div>
				<div class="loading-text">Loading session files...</div>
				<div class="loading-subtext">Analyzing up to 500 files from the last 14 days</div>
			</div>
		`;
	}
	
	if (detailedFiles.length === 0) {
		return '<p style="color: #999;">No session files with activity in the last 14 days.</p>';
	}
	
	// Get editor stats for ALL files (before filtering)
	const editorStats = getEditorStats(detailedFiles);
	const editors = Object.keys(editorStats).sort();
	
	// Apply editor filter
	const filteredFiles = currentEditorFilter 
		? detailedFiles.filter(sf => sf.editorSource === currentEditorFilter)
		: detailedFiles;
	
	// Summary stats for filtered files
	const totalInteractions = filteredFiles.reduce((sum, sf) => sum + Number(sf.interactions || 0), 0);
	const totalContextRefs = filteredFiles.reduce((sum, sf) => sum + getTotalContextRefs(sf.contextReferences), 0);
	
	// Sort filtered files
	const sortedFiles = sortSessionFiles(filteredFiles);
	
	// Build editor filter panels
	const editorPanelsHtml = `
		<div class="editor-filter-panels">
			<div class="editor-panel ${currentEditorFilter === null ? 'active' : ''}" data-editor="">
				<div class="editor-panel-icon">🌐</div>
				<div class="editor-panel-name">All Editors</div>
				<div class="editor-panel-stats">${detailedFiles.length} sessions</div>
			</div>
			${editors.map(editor => `
				<div class="editor-panel ${currentEditorFilter === editor ? 'active' : ''}" data-editor="${escapeHtml(editor)}">
					<div class="editor-panel-icon">${getEditorIcon(editor)}</div>
					<div class="editor-panel-name">${escapeHtml(editor)}</div>
					<div class="editor-panel-stats">${editorStats[editor].count} sessions · ${editorStats[editor].interactions} interactions</div>
				</div>
			`).join('')}
		</div>
	`;
	
	return `
		${editorPanelsHtml}
		
		<div class="summary-cards">
			<div class="summary-card">
				<div class="summary-label">📁 ${currentEditorFilter ? 'Filtered' : 'Total'} Sessions</div>
				<div class="summary-value">${filteredFiles.length}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">💬 Interactions</div>
				<div class="summary-value">${totalInteractions}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">🔗 Context References</div>
				<div class="summary-value">${totalContextRefs}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">📅 Time Range</div>
				<div class="summary-value">Last 14 days</div>
			</div>
		</div>
		
		<div class="table-container">
			<table class="session-table">
				<thead>
					<tr>
						<th>#</th>
						<th>Editor</th>
						<th>Title</th>
						<th>Size</th>
						<th>Interactions</th>
						<th>Context Refs</th>
						<th class="sortable" data-sort="firstInteraction">First Interaction${getSortIndicator('firstInteraction')}</th>
						<th class="sortable" data-sort="lastInteraction">Last Interaction${getSortIndicator('lastInteraction')}</th>
					</tr>
				</thead>
				<tbody>
					${sortedFiles.map((sf, idx) => `
						<tr>
							<td>${idx + 1}</td>
							<td><span class="editor-badge" title="${escapeHtml(sf.editorSource)}">${escapeHtml(sf.editorName || sf.editorSource)}</span></td>
							<td class="session-title" title="${sf.title ? escapeHtml(sf.title) : 'Empty session'}">
								${sf.title ? `<a href="#" class="session-file-link" data-file="${encodeURIComponent(sf.file)}" title="${escapeHtml(sf.title)}">${escapeHtml(sf.title.length > 40 ? sf.title.substring(0, 40) + '...' : sf.title)}</a>` : `<a href="#" class="session-file-link empty-session-link" data-file="${encodeURIComponent(sf.file)}" title="Empty session">(Empty session)</a>`}
							</td>
							<td>${formatFileSize(sf.size)}</td>
							<td>${sanitizeNumber(sf.interactions)}</td>
							<td title="${getContextRefsSummary(sf.contextReferences)}">${sanitizeNumber(getTotalContextRefs(sf.contextReferences))}</td>
							<td>${formatDate(sf.firstInteraction)}</td>
							<td>${formatDate(sf.lastInteraction)}</td>
						</tr>
					`).join('')}
				</tbody>
			</table>
		</div>
	`;
}

function renderBackendStoragePanel(backendInfo: BackendStorageInfo | undefined): string {
	if (!backendInfo) {
		return `
			<div class="info-box">
				<div class="info-box-title">☁️ Azure Storage Backend</div>
				<div>
					Backend storage information is not available. This may be a temporary issue.
				</div>
			</div>
		`;
	}
	
	const statusColor = backendInfo.isConfigured ? '#2d6a4f' : (backendInfo.enabled ? '#d97706' : '#666');
	const statusIcon = backendInfo.isConfigured ? '✅' : (backendInfo.enabled ? '⚠️' : '⚪');
	const statusText = backendInfo.isConfigured ? 'Configured & Enabled' : (backendInfo.enabled ? 'Enabled but Not Configured' : 'Disabled');
	
	const configButtonText = backendInfo.isConfigured ? '⚙️ Manage Backend' : '🔧 Configure Backend';
	const configButtonStyle = backendInfo.isConfigured ? 'secondary' : '';
	
	return `
		<div class="info-box">
			<div class="info-box-title">☁️ Azure Storage Backend</div>
			<div>
				Sync your token usage data to Azure Storage Tables for team-wide reporting and multi-device access.
				Configure Azure resources and authentication settings to enable cloud synchronization.
			</div>
		</div>
		
		<div class="summary-cards">
			<div class="summary-card" style="border-left: 4px solid ${statusColor};">
				<div class="summary-label">${statusIcon} Backend Status</div>
				<div class="summary-value" style="font-size: 16px; color: ${statusColor};">${statusText}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">🔐 Auth Mode</div>
				<div class="summary-value" style="font-size: 16px;">${backendInfo.authMode === 'entraId' ? 'Entra ID' : 'Shared Key'}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">👥 Sharing Profile</div>
				<div class="summary-value" style="font-size: 14px;">${escapeHtml(backendInfo.sharingProfile)}</div>
			</div>
			<div class="summary-card">
				<div class="summary-label">🕒 Last Sync</div>
				<div class="summary-value" style="font-size: 14px;">${backendInfo.lastSyncTime ? getTimeSince(backendInfo.lastSyncTime) : 'Never'}</div>
			</div>
		</div>
		
		${backendInfo.isConfigured ? `
			<div style="margin-top: 24px;">
				<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📊 Configuration Details</h4>
				<table class="session-table">
					<tbody>
						<tr>
							<td style="font-weight: 600; width: 200px;">Storage Account</td>
							<td>${escapeHtml(backendInfo.storageAccount)}</td>
						</tr>
						<tr>
							<td style="font-weight: 600;">Subscription ID</td>
							<td>${escapeHtml(backendInfo.subscriptionId)}</td>
						</tr>
						<tr>
							<td style="font-weight: 600;">Resource Group</td>
							<td>${escapeHtml(backendInfo.resourceGroup)}</td>
						</tr>
						<tr>
							<td style="font-weight: 600;">Aggregation Table</td>
							<td>${escapeHtml(backendInfo.aggTable)}</td>
						</tr>
						<tr>
							<td style="font-weight: 600;">Events Table</td>
							<td>${escapeHtml(backendInfo.eventsTable)}</td>
						</tr>
					</tbody>
				</table>
			</div>
			
			<div style="margin-top: 24px;">
				<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">📈 Local Session Statistics</h4>
				<div class="summary-cards">
					<div class="summary-card">
						<div class="summary-label">💻 Unique Devices</div>
						<div class="summary-value">${backendInfo.deviceCount}</div>
						<div style="font-size: 11px; color: #999; margin-top: 4px;">Based on workspace IDs</div>
					</div>
					<div class="summary-card">
						<div class="summary-label">📁 Total Sessions</div>
						<div class="summary-value">${backendInfo.sessionCount}</div>
						<div style="font-size: 11px; color: #999; margin-top: 4px;">Local session files</div>
					</div>
					<div class="summary-card">
						<div class="summary-label">☁️ Cloud Records</div>
						<div class="summary-value">${backendInfo.recordCount !== null ? backendInfo.recordCount : '—'}</div>
						<div style="font-size: 11px; color: #999; margin-top: 4px;">Azure Storage records</div>
					</div>
					<div class="summary-card">
						<div class="summary-label">🔄 Sync Status</div>
						<div class="summary-value" style="font-size: 14px;">${backendInfo.lastSyncTime ? formatDate(backendInfo.lastSyncTime) : 'Never'}</div>
					</div>
				</div>
			</div>
			
			<div style="margin-top: 24px;">
				<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">ℹ️ About Azure Storage Backend</h4>
				<p style="color: #999; font-size: 12px; margin-bottom: 8px;">
					The Azure Storage backend enables:
				</p>
				<ul style="margin: 8px 0 0 20px; color: #999; font-size: 12px;">
					<li>Team-wide token usage reporting and analytics</li>
					<li>Multi-device synchronization of your usage data</li>
					<li>Long-term storage and historical analysis</li>
					<li>Configurable privacy levels (anonymous, pseudonymous, or identified)</li>
				</ul>
			</div>
		` : `
			<div style="margin-top: 24px;">
				<h4 style="color: #fff; font-size: 14px; margin-bottom: 12px;">🚀 Get Started with Azure Storage</h4>
				<p style="color: #999; font-size: 12px; margin-bottom: 16px;">
					To enable cloud synchronization, you'll need to configure an Azure Storage account.
					The setup wizard will guide you through the process.
				</p>
				<ul style="margin: 8px 0 16px 20px; color: #999; font-size: 12px;">
					<li>Azure subscription with Storage Account access</li>
					<li>Appropriate permissions (Storage Table Data Contributor or Storage Account Key)</li>
					<li>VS Code signed in with your Azure account (for Entra ID auth)</li>
				</ul>
			</div>
		`}
		
		<div class="button-group">
			<button class="button ${configButtonStyle}" id="btn-configure-backend">
				<span>${configButtonText.split(' ')[0]}</span>
				<span>${configButtonText.substring(configButtonText.indexOf(' ') + 1)}</span>
			</button>
			${backendInfo.isConfigured ? `
				<button class="button secondary" id="btn-open-settings">
					<span>⚙️</span>
					<span>Open Backend Settings</span>
				</button>
			` : ''}
		</div>
	`;
}

function renderLayout(data: DiagnosticsData): void {
	const root = document.getElementById('root');
	if (!root) {
		return;
	}

	// Build session folder summary (main entry folders) for reference
	let sessionFilesHtml = '';
	const sessionFolders = (data as any).sessionFolders || [];
	if (sessionFolders.length > 0) {
		// Sort folders by descending count so top folders show first
		const sorted = [...sessionFolders].sort((a, b) => b.count - a.count);
		sessionFilesHtml = `
			<div class="session-folders-table">
				<h4>Main Session Folders (by editor root):</h4>
				<table class="session-table">
					<thead>
						<tr>
							<th>Folder</th>
							<th>Editor</th>
							<th># of Sessions</th>
							<th>Open</th>
						</tr>
					</thead>
					<tbody>`;
		sorted.forEach((sf: { dir: string; count: number; editorName?: string }) => {
			// Shorten common user paths for readability
			let display = sf.dir;
			const home = (window as any).process?.env?.HOME || (window as any).process?.env?.USERPROFILE || '';
			if (home && display.startsWith(home)) {
				display = display.replace(home, '~');
			}
			const editorName = sf.editorName || 'Unknown';
			sessionFilesHtml += `
				<tr>
					<td title="${escapeHtml(sf.dir)}">${escapeHtml(display)}</td>
					<td><span class="editor-badge">${escapeHtml(editorName)}</span></td>
					<td>${sf.count}</td>
					<td><a href="#" class="reveal-link" data-path="${encodeURIComponent(sf.dir)}">Open directory</a></td>
				</tr>`;
		});
		sessionFilesHtml += `
					</tbody>
				</table>
			</div>`;
	}

	// Remove session files section from report text (it's shown separately as clickable links)
	let escapedReport = escapeHtml(data.report);
	
	// Check if we're in loading state for the report
	const reportIsLoading = data.report === LOADING_PLACEHOLDER;
	
	if (!reportIsLoading) {
		// Remove the old session files list from the report text if present
		escapedReport = removeSessionFilesSection(escapedReport);
	} else {
		// Show a better loading message
		escapedReport = LOADING_MESSAGE.trim();
	}

	// Build detailed session files table
	const detailedFiles = data.detailedSessionFiles || [];

	root.innerHTML = `
		<style>
			* { margin: 0; padding: 0; box-sizing: border-box; }
			body {
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
				background: #0e0e0f;
				color: #e7e7e7;
				padding: 16px;
				line-height: 1.5;
				min-width: 320px;
			}
			.container {
				background: linear-gradient(135deg, #1b1b1e 0%, #1f1f22 100%);
				border: 1px solid #2e2e34;
				border-radius: 10px;
				padding: 16px;
				box-shadow: 0 4px 10px rgba(0, 0, 0, 0.28);
				max-width: 1200px;
				margin: 0 auto;
			}
			.header {
				display: flex;
				justify-content: space-between;
				align-items: center;
				gap: 12px;
				margin-bottom: 16px;
				padding-bottom: 4px;
			}
			.header-left { display: flex; align-items: center; gap: 8px; }
			.header-icon { font-size: 20px; }
			.header-title { font-size: 16px; font-weight: 700; color: #fff; }
			.button-row { display: flex; flex-wrap: wrap; gap: 8px; }
			
			/* Tab styles */
			.tabs {
				display: flex;
				border-bottom: 1px solid #5a5a5a;
				margin-bottom: 16px;
			}
			.tab {
				padding: 10px 20px;
				cursor: pointer;
				border: none;
				background: transparent;
				color: #999;
				font-size: 13px;
				font-weight: 500;
				border-bottom: 2px solid transparent;
				transition: all 0.2s;
			}
			.tab:hover { color: #fff; background: rgba(255,255,255,0.05); }
			.tab.active {
				color: #4FC3F7;
				border-bottom-color: #4FC3F7;
			}
			.tab-content { display: none; }
			.tab-content.active { display: block; }
			
			/* Editor filter panels */
			.editor-filter-panels {
				display: flex;
				flex-wrap: wrap;
				gap: 10px;
				margin-bottom: 16px;
			}
			.editor-panel {
				background: #353535;
				border: 2px solid #5a5a5a;
				border-radius: 8px;
				padding: 12px 16px;
				cursor: pointer;
				transition: all 0.2s;
				min-width: 140px;
				text-align: center;
			}
			.editor-panel:hover {
				background: #404040;
				border-color: #7a7a7a;
			}
			.editor-panel.active {
				background: #3a4a5a;
				border-color: #4FC3F7;
			}
			.editor-panel-icon {
				font-size: 24px;
				margin-bottom: 4px;
			}
			.editor-panel-name {
				font-size: 13px;
				font-weight: 600;
				color: #fff;
				margin-bottom: 2px;
			}
			.editor-panel-stats {
				font-size: 10px;
				color: #999;
			}
			
			/* Loading state */
			.loading-state {
				text-align: center;
				padding: 40px 20px;
				color: #999;
			}
			.loading-spinner {
				font-size: 48px;
				margin-bottom: 16px;
				animation: pulse 1.5s ease-in-out infinite;
			}
			@keyframes pulse {
				0%, 100% { opacity: 1; }
				50% { opacity: 0.5; }
			}
			.loading-text {
				font-size: 16px;
				color: #fff;
				margin-bottom: 8px;
			}
			.loading-subtext {
				font-size: 12px;
				color: #888;
			}
			
			/* Summary cards */
			.summary-cards {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
				gap: 12px;
				margin-bottom: 16px;
			}
			.summary-card {
				background: #353535;
				border: 1px solid #5a5a5a;
				border-radius: 4px;
				padding: 12px;
				text-align: center;
			}
			.summary-label { font-size: 11px; color: #b3b3b3; margin-bottom: 4px; }
			.summary-value { font-size: 18px; font-weight: 600; color: #fff; }
			
			/* Table styles */
			.table-container {
				overflow-x: auto;
				max-height: 500px;
				overflow-y: auto;
			}
			.session-table {
				width: 100%;
				border-collapse: collapse;
				font-size: 12px;
			}
			.session-table th, .session-table td {
				padding: 8px 10px;
				text-align: left;
				border-bottom: 1px solid #5a5a5a;
			}
			.session-table th {
				background: #353535;
				color: #fff;
				font-weight: 600;
				position: sticky;
				top: 0;
			}
			.session-table th.sortable {
				cursor: pointer;
				user-select: none;
			}
			.session-table th.sortable:hover {
				background: #454545;
				color: #4FC3F7;
			}
			.session-table tr:hover { background: rgba(255,255,255,0.03); }
			.editor-badge {
				background: #4a5a6a;
				padding: 2px 6px;
				border-radius: 3px;
				font-size: 10px;
				color: #fff;
			}
			
			.session-folders-table {
				margin-top: 16px;
				margin-bottom: 16px;
			}
			.session-folders-table h4 {
				color: #ffffff;
				font-size: 14px;
				margin-bottom: 12px;
			}
			
			.report-content {
				background: #2a2a2a;
				border: 1px solid #5a5a5a;
				border-radius: 4px;
				padding: 16px;
				white-space: pre-wrap;
				font-size: 13px;
				overflow-x: auto;
				max-height: 60vh;
				overflow-y: auto;
			}
			.file-subpath {
				font-size: 11px;
				color: #9aa0a6;
				margin-top: 4px;
			}
			.session-file-link, .reveal-link { color: #4FC3F7; text-decoration: underline; cursor: pointer; }
			.session-file-link:hover, .reveal-link:hover { color: #81D4FA; }
			.empty-session-link { color: #999; }
			.empty-session-link:hover { color: #aaa; }
			.button-group { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
			.button {
				background: #202024;
				border: 1px solid #2d2d33;
				color: #e7e7e7;
				padding: 8px 12px;
				border-radius: 6px;
				cursor: pointer;
				font-size: 13px;
				font-weight: 500;
				transition: background-color 0.15s ease;
				display: inline-flex;
				align-items: center;
				gap: 8px;
			}
			.button:hover { background: #2a2a30; }
			.button:active { background: #0a5a8a; }
			.button:disabled { opacity: 0.6; cursor: not-allowed; }
			.button.secondary { background: #3c3c3c; border-color: #5a5a5a; color: #ffffff; }
			.button.secondary:hover { background: #4a4a4a; }
			.info-box {
				background: #3a4a5a;
				border: 1px solid #4a5a6a;
				border-radius: 4px;
				padding: 12px;
				margin-bottom: 16px;
				font-size: 13px;
			}
			.info-box-title { font-weight: 600; color: #ffffff; margin-bottom: 6px; }
			.cache-details { margin-top: 16px; }
			.cache-location { margin-top: 20px; }
			.cache-location h4 { color: #fff; font-size: 14px; margin-bottom: 8px; }
			.location-box {
				background: #2a2a2a;
				border: 1px solid #5a5a5a;
				border-radius: 4px;
				padding: 12px;
				overflow-x: auto;
			}
			.location-box code { color: #4FC3F7; font-size: 12px; }
			.cache-actions { margin-top: 20px; }
			.cache-actions h4 { color: #fff; font-size: 14px; margin-bottom: 8px; }
		</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">🔍</span>
					<span class="header-title">Diagnostic Report</span>
				</div>
				<div class="button-row">
					${buttonHtml('btn-chart')}
					${buttonHtml('btn-usage')}
					${buttonHtml('btn-details')}
				</div>
			</div>
			
			<div class="tabs">
				<button class="tab active" data-tab="report">📋 Report</button>
				<button class="tab" data-tab="sessions">📁 Session Files (${detailedFiles.length})</button>
				<button class="tab" data-tab="cache">💾 Cache</button>
				<button class="tab" data-tab="backend">☁️ Azure Storage</button>
			</div>
			
			<div id="tab-report" class="tab-content active">
				<div class="info-box">
					<div class="info-box-title">📋 About This Report</div>
					<div>
						This diagnostic report contains information about your GitHub Copilot Token Tracker
						extension setup and usage statistics. </br> It does <strong>not</strong> include any of your
						code or conversation content. You can safely share this report when reporting issues.
					</div>
				</div>
				<div class="report-content">${escapedReport}</div>
				${sessionFilesHtml}
				<div class="button-group">
					<button class="button" id="btn-copy"><span>📋</span><span>Copy to Clipboard</span></button>
					<button class="button secondary" id="btn-issue"><span>🐛</span><span>Open GitHub Issue</span></button>
					<button class="button secondary" id="btn-clear-cache"><span>🗑️</span><span>Clear Cache</span></button>
				</div>
			</div>
			
			<div id="tab-sessions" class="tab-content">
				<div class="info-box">
					<div class="info-box-title">📁 Session File Analysis</div>
					<div>
						This tab shows session files with activity in the last 14 days from all detected editors. </br>
						Click on an editor panel to filter, click column headers to sort, and click a file name to open it.
					</div>
				</div>
				<div id="session-table-container">${renderSessionTable(detailedFiles, detailedFiles.length === 0)}</div>
			</div>
			
			<div id="tab-cache" class="tab-content">
				<div class="info-box">
					<div class="info-box-title">💾 Cache Information</div>
					<div>
						The extension caches session file data to improve performance and reduce file system operations.
						Cache is stored in VS Code's global state and persists across sessions.
					</div>
				</div>
				<div class="cache-details">
					<div class="summary-cards">
						<div class="summary-card">
						<div class="summary-label">📦 Cache Entries</div>
						<div class="summary-value">${data.cacheInfo?.size || 0}</div>
					</div>
					<div class="summary-card">
						<div class="summary-label">💾 Cache Size</div>
						<div class="summary-value">${data.cacheInfo?.sizeInMB ? data.cacheInfo.sizeInMB.toFixed(2) + ' MB' : 'N/A'}</div>
						</div>
						<div class="summary-card">
							<div class="summary-label">🕒 Last Updated</div>
							<div class="summary-value" style="font-size: 14px;">${data.cacheInfo?.lastUpdated ? formatDate(data.cacheInfo.lastUpdated) : 'Never'}</div>
						</div>
						<div class="summary-card">
							<div class="summary-label">⏱️ Cache Age</div>
							<div class="summary-value" style="font-size: 14px;">${data.cacheInfo?.lastUpdated ? getTimeSince(data.cacheInfo.lastUpdated) : 'N/A'}</div>
						</div>
					</div>
					<div class="cache-location">
						<h4>Storage Location</h4>
						<div class="location-box">
							<code>${escapeHtml(data.cacheInfo?.location || 'VS Code Global State')}</code>
							${data.cacheInfo?.storagePath ? ` <a href="#" class="open-storage-link" data-path="${encodeURIComponent(data.cacheInfo.storagePath)}">Open storage location</a>` : ''}
						</div>
						<p style="color: #999; font-size: 12px; margin-top: 8px;">
							Cache is stored in VS Code's global state (extension storage) and includes:
							<ul style="margin: 8px 0 0 20px;">
								<li>Token counts per session file</li>
								<li>Interaction counts</li>
								<li>Model usage statistics</li>
								<li>File modification timestamps for validation</li>
								<li>Usage analysis data (tool calls, modes, context references)</li>
							</ul>
						</p>
					</div>
					<div class="cache-actions">
						<h4>Cache Management</h4>
						<p style="color: #999; font-size: 12px; margin-bottom: 12px;">
							Clearing the cache will force the extension to re-read and re-analyze all session files on the next update.
							This can help resolve issues with stale or incorrect data.
						</p>
						<button class="button secondary" id="btn-clear-cache-tab"><span>🗑️</span><span>Clear Cache</span></button>
					</div>
				</div>
			</div>
			
			<div id="tab-backend" class="tab-content">
				${renderBackendStoragePanel(data.backendStorageInfo)}
			</div>
		</div>
	`;

	// Store data for re-rendering on sort - will be updated when data loads
	let storedDetailedFiles = detailedFiles;
	let isLoading = detailedFiles.length === 0;

	// Listen for messages from the extension (background loading)
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.command === 'diagnosticDataLoaded') {
			// Initial diagnostic data has loaded (report, session folders, backend info)
			// Update the report text and folders
			if (message.report) {
				// Update the report tab content
				const reportTabContent = document.getElementById('tab-report');
				if (reportTabContent) {
					// Process the report text to remove session files section
					const processedReport = removeSessionFilesSection(message.report);
					const reportPre = reportTabContent.querySelector('.report-content');
					if (reportPre) {
						reportPre.textContent = processedReport;
					}
				}
			}

			// Update session folders if provided
			if (message.sessionFolders && message.sessionFolders.length > 0) {
				const reportTabContent = document.getElementById('tab-report');
				if (reportTabContent) {
					const sorted = [...message.sessionFolders].sort((a: any, b: any) => b.count - a.count);

					// Build the session folders table using DOM APIs to avoid HTML injection
					const container = document.createElement('div');
					container.className = 'session-folders-table';

					const heading = document.createElement('h4');
					heading.textContent = 'Main Session Folders (by editor root):';
					container.appendChild(heading);

					const table = document.createElement('table');
					table.className = 'session-table';
					container.appendChild(table);

					const thead = document.createElement('thead');
					table.appendChild(thead);
					const headerRow = document.createElement('tr');
					thead.appendChild(headerRow);

					const headers = ['Folder', 'Editor', '# of Sessions', 'Open'];
					headers.forEach((text) => {
						const th = document.createElement('th');
						th.textContent = text;
						headerRow.appendChild(th);
					});

					const tbody = document.createElement('tbody');
					table.appendChild(tbody);

					sorted.forEach((sf: any) => {
						let display = sf.dir;
						const home = (window as any).process?.env?.HOME || (window as any).process?.env?.USERPROFILE || '';
						if (home && display.startsWith(home)) {
							display = display.replace(home, '~');
						}
						const editorName = sf.editorName || 'Unknown';

						const row = document.createElement('tr');

						// Folder cell
						const folderCell = document.createElement('td');
						folderCell.setAttribute('title', escapeHtml(sf.dir));
						folderCell.textContent = escapeHtml(display);
						row.appendChild(folderCell);

						// Editor cell
						const editorCell = document.createElement('td');
						const editorBadge = document.createElement('span');
						editorBadge.className = 'editor-badge';
						editorBadge.textContent = escapeHtml(editorName);
						editorCell.appendChild(editorBadge);
						row.appendChild(editorCell);

						// Count cell
						const countCell = document.createElement('td');
						countCell.textContent = String(sf.count);
						row.appendChild(countCell);

						// Open link cell
						const openCell = document.createElement('td');
						const link = document.createElement('a');
						link.href = '#';
						link.className = 'reveal-link';
						link.setAttribute('data-path', encodeURIComponent(sf.dir));
						link.textContent = 'Open directory';
						openCell.appendChild(link);
						row.appendChild(openCell);

						tbody.appendChild(row);
					});

					// Find where to insert or replace the session folders table
					// It should be inserted after the report-content div but before the button-group
					const existingTable = reportTabContent.querySelector('.session-folders-table');
					if (existingTable && existingTable.parentNode) {
						existingTable.parentNode.replaceChild(container, existingTable);
					} else {
						// Insert after the report-content div
						const reportContent = reportTabContent.querySelector('.report-content');
						if (reportContent && reportContent.parentNode) {
							if (reportContent.nextSibling) {
								reportContent.parentNode.insertBefore(container, reportContent.nextSibling);
							} else {
								reportContent.parentNode.appendChild(container);
							}
						}
					}
					setupStorageLinkHandlers();
				}
			}

			// Diagnostic data loaded successfully - no console needed as this is normal operation
		} else if (message.command === 'diagnosticDataError') {
			// Show error message
			console.error('Error loading diagnostic data:', message.error);
			const root = document.getElementById('root');
			if (root) {
				const errorDiv = document.createElement('div');
				errorDiv.style.cssText = 'color: #ff6b6b; padding: 20px; text-align: center;';
				errorDiv.innerHTML = `
					<h3>⚠️ Error Loading Diagnostic Data</h3>
					<p>${escapeHtml(message.error || 'Unknown error')}</p>
				`;
				root.insertBefore(errorDiv, root.firstChild);
			}
		} else if (message.command === 'sessionFilesLoaded' && message.detailedSessionFiles) {
			storedDetailedFiles = message.detailedSessionFiles;
			isLoading = false;
			
			// Update tab count
			const sessionsTab = document.querySelector('.tab[data-tab="sessions"]');
			if (sessionsTab) {
				sessionsTab.textContent = `📁 Session Files (${storedDetailedFiles.length})`;
			}
			
			// Re-render the table
			reRenderTable();
		} else if (message.command === 'cacheCleared') {
			// Reset button states to indicate success
			const btnReport = document.getElementById('btn-clear-cache') as HTMLButtonElement | null;
			const btnTab = document.getElementById('btn-clear-cache-tab') as HTMLButtonElement | null;
			if (btnReport) {
				btnReport.style.background = '#2d6a4f';
				btnReport.innerHTML = '<span>✅</span><span>Cache Cleared</span>';
				btnReport.disabled = false;
			}
			if (btnTab) {
				btnTab.style.background = '#2d6a4f';
				btnTab.innerHTML = '<span>✅</span><span>Cache Cleared</span>';
				btnTab.disabled = false;
			}
			
			console.log('DEBUG Cache cleared confirmation received');
			
			// Re-enable buttons after a short delay and reset to original state
			setTimeout(() => {
				if (btnReport) {
					btnReport.style.background = '';
					btnReport.innerHTML = '<span>🗑️</span><span>Clear Cache</span>';
				}
				if (btnTab) {
					btnTab.style.background = '';
					btnTab.innerHTML = '<span>🗑️</span><span>Clear Cache</span>';
				}
			}, 2000);
		} else if (message.command === 'cacheRefreshed') {
			// Update cache numbers with refreshed data
			if (message.cacheInfo) {
				const cacheInfo = message.cacheInfo;
				const cacheTabContent = document.getElementById('tab-cache');
				if (cacheTabContent) {
					const summaryCards = cacheTabContent.querySelectorAll('.summary-card');
					if (summaryCards.length >= 4) {
						const entriesValue = summaryCards[0]?.querySelector('.summary-value');
						if (entriesValue) { entriesValue.textContent = String(cacheInfo.size); }
						
						const sizeValue = summaryCards[1]?.querySelector('.summary-value');
						if (sizeValue) { sizeValue.textContent = `${cacheInfo.sizeInMB.toFixed(2)} MB`; }
						
						const lastUpdatedValue = summaryCards[2]?.querySelector('.summary-value');
						if (lastUpdatedValue) { 
							const date = new Date(cacheInfo.lastUpdated);
							lastUpdatedValue.textContent = date.toLocaleString();
						}
						
						const ageValue = summaryCards[3]?.querySelector('.summary-value');
						if (ageValue) { ageValue.textContent = '0 seconds ago'; }
					}
				}
				console.log('DEBUG Cache refreshed with new data:', cacheInfo);
			}
		}
	});

// Handle open storage link clicks
function setupStorageLinkHandlers(): void {
	document.querySelectorAll('.open-storage-link').forEach(link => {
		link.addEventListener('click', (e) => {
			e.preventDefault();
			const path = decodeURIComponent((link as HTMLElement).getAttribute('data-path') || '');
			if (path) {
				vscode.postMessage({ command: 'revealPath', path });
			}
		});
	});
}

	// Helper function to activate a tab by its ID
	function activateTab(tabId: string): boolean {
		const tabButton = document.querySelector(`.tab[data-tab="${tabId}"]`);
		const tabContent = document.getElementById(`tab-${tabId}`);
		
		if (tabButton && tabContent) {
			// Remove active class from all tabs and contents
			document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
			document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
			
			// Activate the specified tab
			tabButton.classList.add('active');
			tabContent.classList.add('active');
			return true;
		}
		return false;
	}

	// Wire up tab switching
	document.querySelectorAll('.tab').forEach(tab => {
		tab.addEventListener('click', () => {
			const tabId = (tab as HTMLElement).getAttribute('data-tab');
			
			if (tabId && activateTab(tabId)) {
				// Save the active tab state
				vscode.setState({ activeTab: tabId });
			}
		});
	});

	// Wire up sortable column headers
	function setupSortHandlers(): void {
		document.querySelectorAll('.sortable').forEach(header => {
			header.addEventListener('click', () => {
				const sortColumn = (header as HTMLElement).getAttribute('data-sort') as 'firstInteraction' | 'lastInteraction';
				if (sortColumn) {
					// Toggle direction if same column, otherwise default to desc
					if (currentSortColumn === sortColumn) {
						currentSortDirection = currentSortDirection === 'desc' ? 'asc' : 'desc';
					} else {
						currentSortColumn = sortColumn;
						currentSortDirection = 'desc';
					}
					
					// Re-render table
					reRenderTable();
				}
			});
		});
	}

	// Wire up editor filter panel handlers
	function setupEditorFilterHandlers(): void {
		document.querySelectorAll('.editor-panel').forEach(panel => {
			panel.addEventListener('click', () => {
				const editor = (panel as HTMLElement).getAttribute('data-editor');
				currentEditorFilter = editor === '' ? null : editor;
				
				// Re-render table
				reRenderTable();
			});
		});
	}

	// Re-render the session table with current filter/sort state
	function reRenderTable(): void {
		const container = document.getElementById('session-table-container');
		if (container) {
			container.innerHTML = renderSessionTable(storedDetailedFiles, isLoading);
			if (!isLoading) {
				setupSortHandlers();
				setupEditorFilterHandlers();
				setupFileLinks();
			}
		}
	}

	// Wire up file link handlers
	function setupFileLinks(): void {
		document.querySelectorAll('.session-file-link').forEach(link => {
			link.addEventListener('click', (e) => {
				e.preventDefault();
				const file = decodeURIComponent((link as HTMLElement).getAttribute('data-file') || '');
				vscode.postMessage({ command: 'openSessionFile', file });
			});
		});

		// Reveal link handlers
		document.querySelectorAll('.reveal-link').forEach(link => {
			link.addEventListener('click', (e) => {
				e.preventDefault();
				const path = decodeURIComponent((link as HTMLElement).getAttribute('data-path') || '');
				vscode.postMessage({ command: 'revealPath', path });
			});
		});
	}

	// Wire up event listeners
	document.getElementById('btn-copy')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'copyReport' });
	});

	document.getElementById('btn-issue')?.addEventListener('click', () => {
		vscode.postMessage({ command: 'openIssue' });
	});

	// Helper function to update cache numbers to zero
	function updateCacheNumbers(): void {
		const cacheTabContent = document.getElementById('tab-cache');
		if (cacheTabContent) {
			const summaryCards = cacheTabContent.querySelectorAll('.summary-card');
			if (summaryCards.length >= 4) {
				const entriesValue = summaryCards[0]?.querySelector('.summary-value');
				if (entriesValue) { entriesValue.textContent = '0'; }
				
				const sizeValue = summaryCards[1]?.querySelector('.summary-value');
				if (sizeValue) { sizeValue.textContent = '0 MB'; }
				
				const lastUpdatedValue = summaryCards[2]?.querySelector('.summary-value');
				if (lastUpdatedValue) { lastUpdatedValue.textContent = 'Never'; }
				
				const ageValue = summaryCards[3]?.querySelector('.summary-value');
				if (ageValue) { ageValue.textContent = 'N/A'; }
			}
		}
	}

	document.getElementById('btn-clear-cache')?.addEventListener('click', () => {
		console.log('DEBUG Clear cache button clicked (report tab)');
		const btn = document.getElementById('btn-clear-cache') as HTMLButtonElement | null;
		if (btn) {
			btn.style.background = '#d97706';
			btn.innerHTML = '<span>⏳</span><span>Clearing...</span>';
			btn.disabled = true;
		}
		// Immediately update cache numbers (optimistic update)
		updateCacheNumbers();
		vscode.postMessage({ command: 'clearCache' });
	});

	document.getElementById('btn-clear-cache-tab')?.addEventListener('click', () => {
		console.log('DEBUG Clear cache button clicked (cache tab)');
		const btn = document.getElementById('btn-clear-cache-tab') as HTMLButtonElement | null;
		if (btn) {
			btn.style.background = '#d97706';
			btn.innerHTML = '<span>⏳</span><span>Clearing...</span>';
			btn.disabled = true;
		}
		// Immediately update cache numbers (optimistic update)
		updateCacheNumbers();
		vscode.postMessage({ command: 'clearCache' });
	});

	// Fallback click delegation in case direct listeners are not attached
	document.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		if (!target) { return; }
		if (target.id === 'btn-clear-cache' || target.id === 'btn-clear-cache-tab') {
			console.log('DEBUG Clear cache button clicked via delegated handler', target.id);
			target.style.background = '#d97706';
			target.innerHTML = '<span>⏳</span><span>Clearing...</span>';
			if (target instanceof HTMLButtonElement) {
				target.disabled = true;
			}
			// Immediately update cache numbers (optimistic update)
			updateCacheNumbers();
			vscode.postMessage({ command: 'clearCache' });
		}
	});

	// Navigation buttons (match details view)
	document.getElementById('btn-chart')?.addEventListener('click', () => vscode.postMessage({ command: 'showChart' }));
	document.getElementById('btn-usage')?.addEventListener('click', () => vscode.postMessage({ command: 'showUsageAnalysis' }));
	document.getElementById('btn-details')?.addEventListener('click', () => vscode.postMessage({ command: 'showDetails' }));

	// Backend configuration buttons
	document.getElementById('btn-configure-backend')?.addEventListener('click', () => {
		console.log('[DEBUG] Configure backend button clicked');
		vscode.postMessage({ command: 'configureBackend' });
	});
	
	document.getElementById('btn-open-settings')?.addEventListener('click', () => {
		console.log('[DEBUG] Open settings button clicked');
		vscode.postMessage({ command: 'openSettings' });
	});

	setupSortHandlers();
	setupEditorFilterHandlers();
	setupFileLinks();
	setupStorageLinkHandlers();
	
	// Restore active tab from saved state, with fallback to default
	const savedState = vscode.getState();
	if (savedState?.activeTab && !activateTab(savedState.activeTab)) {
		// If saved tab doesn't exist (e.g., structure changed), activate default "report" tab
		activateTab('report');
	}
}

async function bootstrap(): Promise<void> {
	const { provideVSCodeDesignSystem, vsCodeButton } = await import('@vscode/webview-ui-toolkit');
	provideVSCodeDesignSystem().register(vsCodeButton());

	if (!initialData) {
		const root = document.getElementById('root');
		if (root) {
			root.textContent = 'No data available.';
		}
		return;
	}
	renderLayout(initialData);
}

void bootstrap();
