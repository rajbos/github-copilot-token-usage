// Diagnostics Report webview with tabbed interface
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
};

type DiagnosticsData = {
	report: string;
	sessionFiles: { file: string; size: number; modified: string }[];
	detailedSessionFiles?: SessionFileDetails[];
};

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

declare global {
	interface Window { __INITIAL_DIAGNOSTICS__?: DiagnosticsData; }
}

const vscode = acquireVsCodeApi();
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

function formatDate(isoString: string | null): string {
	if (!isoString) { return 'N/A'; }
	try {
		return new Date(isoString).toLocaleString();
	} catch {
		return isoString;
	}
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) { return `${bytes} B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
	const totalInteractions = filteredFiles.reduce((sum, sf) => sum + sf.interactions, 0);
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
						<th>File Name</th>
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
							<td>
								<a href="#" class="session-file-link" data-file="${encodeURIComponent(sf.file)}" title="${escapeHtml(sf.file)}">${escapeHtml(getFileName(sf.file))}</a>
							</td>
							<td>${formatFileSize(sf.size)}</td>
							<td>${sf.interactions}</td>
							<td title="${getContextRefsSummary(sf.contextReferences)}">${getTotalContextRefs(sf.contextReferences)}</td>
							<td>${formatDate(sf.firstInteraction)}</td>
							<td>${formatDate(sf.lastInteraction)}</td>
						</tr>
					`).join('')}
				</tbody>
			</table>
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
	// Remove the old session files list from the report text if present
	const sessionMatch = escapedReport.match(/Session File Locations \(first 20\):[\s\S]*?(?=\n\s*\n|={70})/);
	if (sessionMatch) {
		escapedReport = escapedReport.replace(sessionMatch[0], '');
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
		</style>
		<div class="container">
			<div class="header">
				<div class="header-left">
					<span class="header-icon">🔍</span>
					<span class="header-title">Diagnostic Report</span>
				</div>
				<div class="button-row">
					<vscode-button id="btn-chart">📈 Chart</vscode-button>
					<vscode-button id="btn-usage">📊 Usage Analysis</vscode-button>
					<vscode-button id="btn-details">📋 Details</vscode-button>
				</div>
			</div>
			
			<div class="tabs">
				<button class="tab active" data-tab="report">📋 Report</button>
				<button class="tab" data-tab="sessions">📁 Session Files (${detailedFiles.length})</button>
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
		</div>
	`;

	// Store data for re-rendering on sort - will be updated when data loads
	let storedDetailedFiles = detailedFiles;
	let isLoading = detailedFiles.length === 0;

	// Listen for messages from the extension (background loading)
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.command === 'sessionFilesLoaded' && message.detailedSessionFiles) {
			storedDetailedFiles = message.detailedSessionFiles;
			isLoading = false;
			
			// Update tab count
			const sessionsTab = document.querySelector('.tab[data-tab="sessions"]');
			if (sessionsTab) {
				sessionsTab.textContent = `📁 Session Files (${storedDetailedFiles.length})`;
			}
			
			// Re-render the table
			reRenderTable();
		}
	});

	// Wire up tab switching
	document.querySelectorAll('.tab').forEach(tab => {
		tab.addEventListener('click', () => {
			const tabId = (tab as HTMLElement).getAttribute('data-tab');
			
			// Update active tab
			document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
			tab.classList.add('active');
			
			// Update active content
			document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
			const content = document.getElementById(`tab-${tabId}`);
			if (content) { content.classList.add('active'); }
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

	// Navigation buttons (match details view)
	document.getElementById('btn-chart')?.addEventListener('click', () => vscode.postMessage({ command: 'showChart' }));
	document.getElementById('btn-usage')?.addEventListener('click', () => vscode.postMessage({ command: 'showUsageAnalysis' }));
	document.getElementById('btn-details')?.addEventListener('click', () => vscode.postMessage({ command: 'showDetails' }));

	setupSortHandlers();
	setupEditorFilterHandlers();
	setupFileLinks();
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
