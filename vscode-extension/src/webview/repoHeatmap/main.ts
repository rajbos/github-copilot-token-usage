// Repository Heatmap webview: every file an agent touched, one cell per file, grouped by folder.
import { el, createButton } from '../shared/domUtils';
import themeStyles from '../shared/theme.css';
import dataTableStyles from '../shared/dataTable.css';
import styles from './styles.css';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';
import { registerMessageHandler } from '../shared/messageHandler';
import { createPeriodSelector, CANONICAL_PERIODS } from '../shared/periodSelector';
import { formatNumber } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { applyWebviewLocale, type WebviewLocaleFields } from '../shared/webviewLocale';
import { FILE_ACTIVITY_KINDS, type FileActivityKind } from '../../../../src/fileActivity';
import {
	summarizeRepoHeatmap,
	type RepoHeatmapCell,
	type RepoHeatmapRepo,
	type RepoHeatmapSummary,
	type RepoHeatmapViewData,
} from '../../../../src/repoHeatmapViewBuilder';
import type { ChartTimeWindow } from '../../../../src/types';

declare function acquireVsCodeApi<TState = unknown>(): {
	postMessage: (message: unknown) => void;
	setState: (newState: TState) => void;
	getState: () => TState | undefined;
};

type InitialRepoHeatmap = WebviewLocaleFields & { data: RepoHeatmapViewData | null; loading?: boolean };
type HostMessage =
	| { command: 'progress'; done: number; total: number }
	| { command: 'data'; data: RepoHeatmapViewData }
	| { command: 'error' };
type ViewState = { period: ChartTimeWindow; repoKey?: string; kinds: FileActivityKind[] };

const vscode = acquireVsCodeApi<ViewState>();
const initial = getWindowData<InitialRepoHeatmap>('__INITIAL_REPO_HEATMAP__') ?? { data: null, loading: true };
applyWebviewLocale(initial);

const kindLabel = (kind: FileActivityKind): string => localize(`repoHeatmap.kind.${kind}`);
const fileCount = (n: number): string => localizeFormat(n === 1 ? 'repoHeatmap.fileCount.one' : 'repoHeatmap.fileCount.other', formatNumber(n));
const touchCount = (n: number): string => localizeFormat(n === 1 ? 'repoHeatmap.touchCount.one' : 'repoHeatmap.touchCount.other', formatNumber(n));
const KIND_INDEX: Record<FileActivityKind, number> = { read: 0, edited: 1, created: 2, deleted: 3 };

const saved = vscode.getState();
const state: ViewState = {
	period: saved?.period ?? 'last30',
	repoKey: saved?.repoKey,
	kinds: saved?.kinds?.length ? saved.kinds : [...FILE_ACTIVITY_KINDS],
};
let data: RepoHeatmapViewData | null = initial.data;
let progress: { done: number; total: number } | null = initial.loading ? { done: 0, total: 0 } : null;
let hasError = false;
let selectedPath = '';

function persist(): void { vscode.setState({ ...state }); }

function currentRepo(): RepoHeatmapRepo | undefined {
	if (!data) { return undefined; }
	return data.repos.find(r => r.key === state.repoKey) ?? data.repos[0];
}

/** The kind that dominates a cell among the selected kinds, which decides its colour. */
function dominantKind(cell: RepoHeatmapCell, kinds: ReadonlySet<FileActivityKind>): FileActivityKind {
	let best: FileActivityKind = 'read', bestCount = -1;
	// Writes outrank reads on a tie: a file that was both read and edited is an edited file.
	for (const kind of ['deleted', 'created', 'edited', 'read'] as FileActivityKind[]) {
		const n = kinds.has(kind) ? cell.counts[KIND_INDEX[kind]] : 0;
		if (n > bestCount) { best = kind; bestCount = n; }
	}
	return best;
}

function cellTooltip(cell: RepoHeatmapCell): string {
	const parts = FILE_ACTIVITY_KINDS.filter(k => cell.counts[KIND_INDEX[k]] > 0).map(k => localizeFormat('repoHeatmap.kindCount', kindLabel(k), cell.counts[KIND_INDEX[k]]));
	const inferred = cell.inferredDeletes ? localize('repoHeatmap.inferredDelete') : '';
	return `${localizeFormat('repoHeatmap.cellTooltip', cell.path, parts.join(', '))}${inferred}`;
}

function buildCell(cell: RepoHeatmapCell, summary: RepoHeatmapSummary, kinds: ReadonlySet<FileActivityKind>, detail: HTMLElement): HTMLButtonElement {
	const kind = dominantKind(cell, kinds);
	const button = el('button', `cell kind-${kind}`);
	button.type = 'button';
	// Square-root scale so a few busy files do not wash every other cell out to nothing.
	const intensity = 0.25 + 0.75 * Math.sqrt(cell.total / Math.max(1, summary.maxCellTotal));
	button.style.setProperty('--intensity', intensity.toFixed(2));
	if (kinds.has('deleted') && cell.counts[KIND_INDEX.deleted] > 0 && kind !== 'deleted') { button.classList.add('has-delete'); }
	button.title = cellTooltip(cell);
	button.setAttribute('aria-label', cellTooltip(cell));
	button.dataset.path = cell.path;
	if (cell.path === selectedPath) { button.classList.add('selected'); }
	button.addEventListener('click', () => {
		selectedPath = cell.path;
		detail.textContent = cellTooltip(cell);
		document.querySelectorAll('.cell.selected').forEach(n => n.classList.remove('selected'));
		button.classList.add('selected');
	});
	return button;
}

function buildFolders(summary: RepoHeatmapSummary, kinds: ReadonlySet<FileActivityKind>, detail: HTMLElement): HTMLElement {
	const wrap = el('div', 'folders');
	for (const folder of summary.folders) {
		const group = el('details', 'folder');
		group.open = true;
		const head = el('summary');
		head.append(
			el('span', 'folder-name', folder.folder === '.' ? localize('repoHeatmap.folderRoot') : folder.folder),
			el('span', 'folder-meta', localizeFormat('repoHeatmap.folderMeta', fileCount(folder.files.length), touchCount(folder.total))),
		);
		const cells = el('div', 'cells');
		cells.append(...folder.files.map(f => buildCell(f, summary, kinds, detail)));
		group.append(head, cells);
		wrap.append(group);
	}
	return wrap;
}

function buildKindToggles(onChange: () => void): HTMLElement {
	const wrap = el('div', 'kind-toggles');
	for (const kind of FILE_ACTIVITY_KINDS) {
		const button = el('button', `kind-toggle kind-${kind}`);
		button.type = 'button';
		button.setAttribute('aria-pressed', String(state.kinds.includes(kind)));
		button.append(el('span', 'kind-swatch'), document.createTextNode(kindLabel(kind)));
		button.addEventListener('click', () => {
			const on = state.kinds.includes(kind);
			// At least one kind stays selected, or the heatmap would be permanently empty.
			if (on && state.kinds.length === 1) { return; }
			state.kinds = on ? state.kinds.filter(k => k !== kind) : [...state.kinds, kind];
			persist();
			onChange();
		});
		wrap.append(button);
	}
	return wrap;
}

function buildRepoSelect(rerender: () => void): HTMLElement[] {
	if (!data || data.repos.length === 0) { return []; }
	const select = document.createElement('select');
	select.id = 'repo-select';
	for (const repo of data.repos) {
		const option = document.createElement('option');
		option.value = repo.key;
		option.textContent = repo.label;
		option.selected = repo.key === currentRepo()?.key;
		select.append(option);
	}
	select.addEventListener('change', () => { state.repoKey = select.value; selectedPath = ''; persist(); rerender(); });
	return [el('span', 'toolbar-label', localize('repoHeatmap.repository')), select, buildKindToggles(rerender)];
}

function buildToolbar(rerender: () => void): HTMLElement {
	const toolbar = el('div', 'toolbar');
	const periodSelector = createPeriodSelector({
		selected: state.period,
		periods: CANONICAL_PERIODS,
		id: 'period-selector',
		onChange: value => { state.period = value as ChartTimeWindow; persist(); rerender(); },
	});
	toolbar.append(periodSelector.wrapper, ...buildRepoSelect(rerender));
	return toolbar;
}

function buildNotes(repo: RepoHeatmapRepo, view: RepoHeatmapViewData): HTMLElement {
	const notes: string[] = [];
	if (repo.truncatedFiles > 0) { notes.push(localizeFormat('repoHeatmap.note.truncated', formatNumber(repo.files.length), formatNumber(repo.truncatedFiles))); }
	if (view.outsideRepoTouches > 0) { notes.push(localizeFormat('repoHeatmap.note.outside', formatNumber(view.outsideRepoTouches))); }
	notes.push(localize('repoHeatmap.note.privacy'));
	return el('div', 'footnote', notes.join(' '));
}

function progressText(): string {
	if (!progress) { return ''; }
	return progress.total > 0
		? localizeFormat('repoHeatmap.scanningProgress', formatNumber(progress.done), formatNumber(progress.total))
		: localize('repoHeatmap.scanning');
}

function buildBody(): HTMLElement {
	const body = el('div', 'body');
	if (hasError) { body.append(el('div', 'empty', localize('repoHeatmap.error'))); return body; }
	const repo = currentRepo();
	// A refresh keeps the previous heatmap on screen; only a first scan has nothing to show yet.
	if (progress && !repo) { body.append(el('div', 'progress', progressText())); return body; }
	if (!data || !repo) {
		body.append(el('div', 'empty', localize('repoHeatmap.empty')));
		return body;
	}
	const kinds = new Set(state.kinds);
	// Periods count back from the scan time, so the view matches the data it was built from.
	const summary = summarizeRepoHeatmap(repo, state.period, new Date(data.lastUpdated), kinds);
	const detail = el('div', 'detail', localize('repoHeatmap.selectCell'));
	detail.id = 'cell-detail';
	const totals = localizeFormat('repoHeatmap.totals', ...FILE_ACTIVITY_KINDS.map(k => formatNumber(summary.counts[KIND_INDEX[k]])));
	const headline = localizeFormat('repoHeatmap.summary', repo.label, fileCount(summary.fileCount), totals);
	body.append(el('div', 'summary', progress ? localizeFormat('repoHeatmap.summaryRefreshing', headline, progressText()) : headline), detail);
	body.append(summary.fileCount === 0
		? el('div', 'empty', localize('repoHeatmap.noMatch'))
		: buildFolders(summary, kinds, detail));
	body.append(buildNotes(repo, data));
	return body;
}

function render(): void {
	const root = document.getElementById('root');
	if (!root) { return; }
	root.replaceChildren();
	const themeStyle = document.createElement('style');
	themeStyle.textContent = `${themeStyles}
${dataTableStyles}`;
	const style = document.createElement('style');
	style.textContent = styles;
	const container = el('div', 'container');
	const header = el('div', 'header');
	const refresh = createButton({ id: 'btn-refresh', label: localize('nav.btnRefresh'), icon: 'refresh', appearance: 'primary' });
	refresh.addEventListener('click', () => { progress = { done: 0, total: 0 }; render(); vscode.postMessage({ command: 'refresh' }); });
	header.append(el('div', 'title', localize('repoHeatmap.title')), refresh);
	container.append(header, buildToolbar(render), buildBody());
	root.append(themeStyle, style, container);
}

registerMessageHandler<HostMessage>(message => {
	if (message.command === 'progress') { progress = { done: message.done, total: message.total }; }
	else if (message.command === 'data') { data = message.data; progress = null; hasError = false; }
	else if (message.command === 'error') { progress = null; hasError = true; }
	render();
});

async function bootstrap(): Promise<void> {
	await import('@vscode-elements/elements/dist/vscode-button/index.js');
	render();
	vscode.postMessage({ command: 'ready' });
}

void bootstrap();
