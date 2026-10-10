/**
 * Skill Suggestions section (Usage Analysis → Tools & Integrations tab).
 *
 * Renders the repeated-task clusters as a paged list of cards. Each card has a
 * "Create skill with Copilot" action that drafts (never submits) a Copilot Chat
 * prompt, a "Copy prompt" action, and a paged sessions table whose rows open
 * the session viewer. The card list and the sessions tables are shared data
 * tables (`../shared/dataTable`), which own paging, sorting, focus and
 * announcements; this module only wires the card buttons. The prompt itself
 * is built by the shared, pure
 * `buildSkillCreationPrompt()` in `src/repeatedTasks.ts`.
 */
import { setHtml } from '../shared/domUtils';
import { escapeHtml, formatAbsoluteDate } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { buildSkillCreationPrompt, resolveSkillTarget } from '../../../../src/repeatedTasks';
import type { RepeatedTaskCluster, RepeatedTaskReport, RepeatedTaskSessionRef } from '../../../../src/types';
import {
	getDataTablePage,
	getDataTableState,
	renderDataTable,
	setDataTableState,
	type DataTableColumn,
	type DataTablePage,
} from '../shared/dataTable';

export type { RepeatedTaskCluster, RepeatedTaskReport, RepeatedTaskSessionRef };

/** Cards are tall (badge, quote, keywords, sessions), so a page holds only a few. */
export const SKILL_SUGGESTIONS_PAGE_SIZE = 5;
export const SKILL_SUGGESTIONS_LIST_ID = 'skill-suggestions';
export const SKILL_SUGGESTIONS_SECTION_ID = 'section-skill-suggestions';
const SESSIONS_TABLE_PREFIX = 'skill-sessions-';

export function sessionsTableId(clusterIndex: number): string {
	return `${SESSIONS_TABLE_PREFIX}${clusterIndex}`;
}

// ── Sanitizing the host payload ────────────────────────────────────────────

function sanitizeStringArray(raw: unknown): string[] {
	return Array.isArray(raw) ? raw.filter((v: unknown): v is string => typeof v === 'string') : [];
}

export function sanitizeRepeatedTaskCluster(raw: any): RepeatedTaskCluster | null {
	if (!raw || typeof raw !== 'object') { return null; }
	if (typeof raw.representativePrompt !== 'string' || typeof raw.sessionCount !== 'number' || !Array.isArray(raw.sessions)) { return null; }
	const sessions: RepeatedTaskSessionRef[] = raw.sessions
		.filter((s: any) => s && typeof s === 'object' && typeof s.file === 'string')
		.map((s: any): RepeatedTaskSessionRef => ({
			file: s.file,
			title: typeof s.title === 'string' ? s.title : null,
			lastInteraction: typeof s.lastInteraction === 'string' ? s.lastInteraction : null,
			repository: typeof s.repository === 'string' ? s.repository : undefined,
		}));
	if (sessions.length === 0) { return null; }
	return {
		representativePrompt: raw.representativePrompt,
		// Derive from the sanitized session list so the UI count can never
		// disagree with it (and NaN/float counts are impossible).
		sessionCount: sessions.length,
		repositories: sanitizeStringArray(raw.repositories),
		sessions,
		sharedKeywords: sanitizeStringArray(raw.sharedKeywords),
		// Optional: payloads cached by an older build have no examples.
		examplePrompts: sanitizeStringArray(raw.examplePrompts),
	};
}

export function sanitizeRepeatedTaskReport(raw: any): RepeatedTaskReport | null {
	if (!raw || typeof raw !== 'object' || !Array.isArray(raw.clusters)) { return null; }
	const clusters = raw.clusters.map(sanitizeRepeatedTaskCluster).filter((c: RepeatedTaskCluster | null): c is RepeatedTaskCluster => c !== null);
	if (clusters.length === 0) { return null; }
	return {
		minClusterSize: typeof raw.minClusterSize === 'number' ? raw.minClusterSize : 2,
		sessionsScanned: typeof raw.sessionsScanned === 'number' ? raw.sessionsScanned : 0,
		clusters,
	};
}

// ── Rendering ──────────────────────────────────────────────────────────────

const SESSIONS_INITIAL_SORT = { columnId: 'date', direction: 'desc' } as const;

// setDataTableState() applies before or after the first render (and keeps a
// table's initialSort), so these work without depending on a prior render.

/** Move the suggestion list to a page (clamped on the next render). */
export function setSkillSuggestionsPage(page: number): void {
	setDataTableState(SKILL_SUGGESTIONS_LIST_ID, { page: Math.max(1, Math.floor(page)) });
}

/** Move one suggestion's sessions table to a page (clamped on the next render). */
export function setSkillSessionsPage(clusterIndex: number, page: number): void {
	setDataTableState(sessionsTableId(clusterIndex), { page: Math.max(1, Math.floor(page)) });
}

/** The page of suggestions the list would show for the current state. */
export function getSkillSuggestionsPage(clusters: readonly RepeatedTaskCluster[]): DataTablePage<RepeatedTaskCluster> {
	const state = getDataTableState(SKILL_SUGGESTIONS_LIST_ID);
	return getDataTablePage(clusters, [], state, { pageSize: SKILL_SUGGESTIONS_PAGE_SIZE });
}

function sessionTitle(session: RepeatedTaskSessionRef): string {
	return session.title || session.file.split(/[\\/]/).pop() || session.file;
}

function sessionTimestamp(session: RepeatedTaskSessionRef): number | null {
	const time = session.lastInteraction ? Date.parse(session.lastInteraction) : NaN;
	return Number.isNaN(time) ? null : time;
}

function sessionDateLabel(session: RepeatedTaskSessionRef): string {
	const time = sessionTimestamp(session);
	return time === null ? '' : formatAbsoluteDate(time);
}

// Built per render: the localized labels are only available after the host's dictionary loads.
function sessionColumns(): DataTableColumn<RepeatedTaskSessionRef>[] {
	return [
		{ id: 'session', label: localize('usage.skillSuggestions.column.session'), className: 'data-table-wrap-anywhere', sortValue: sessionTitle, render: sessionTitle },
		{ id: 'date', label: localize('usage.skillSuggestions.column.date'), sortValue: sessionTimestamp, firstSortDirection: 'desc', render: sessionDateLabel },
		{ id: 'repository', label: localize('usage.skillSuggestions.column.repository'), sortValue: s => s.repository ?? null, render: s => s.repository ?? '' },
		{
			id: 'actions',
			label: localize('usage.skillSuggestions.column.actions'),
			render: s => ({
				html: `<button type="button" class="skill-suggestion-open-session" data-file="${escapeHtml(s.file)}" title="${escapeHtml(localize('usage.skillSuggestions.openSessionTooltip'))}" style="font-size:11px; padding:2px 8px; border-radius:4px; border:1px solid var(--border-color); background:var(--button-secondary-bg); color:var(--button-secondary-fg); cursor:pointer;">${escapeHtml(localize('usage.skillSuggestions.openSession'))}</button>`,
			}),
		},
	];
}

/** Paged, sortable sessions table (title, date, repository, open button) for one suggestion. */
export function renderSkillSessionsTable(cluster: RepeatedTaskCluster, clusterIndex: number): string {
	return renderDataTable({
		tableId: sessionsTableId(clusterIndex),
		ariaLabel: localize('usage.skillSuggestions.sessionsTableLabel'),
		rows: cluster.sessions,
		columns: sessionColumns(),
		initialSort: SESSIONS_INITIAL_SORT,
		className: 'data-table--compact',
	});
}

function buildTargetHint(cluster: RepeatedTaskCluster): string {
	const target = resolveSkillTarget(cluster);
	return target.kind === 'workspace'
		? localizeFormat('usage.skillSuggestions.target.workspace', target.repository)
		: localize('usage.skillSuggestions.target.user');
}

function buildClusterCardHtml(cluster: RepeatedTaskCluster, clusterIndex: number): string {
	const keywords = cluster.sharedKeywords.length > 0
		? `<div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:4px;">${cluster.sharedKeywords.map(k => `<span style="font-size:10px; padding:1px 7px; border-radius:8px; background:var(--bg-tertiary); color:var(--text-secondary);">${escapeHtml(k)}</span>`).join('')}</div>`
		: '';
	return `
		<div class="skill-suggestion-card" data-cluster-index="${clusterIndex}" style="padding:4px 2px;">
			<div style="display:flex; align-items:flex-start; gap:10px; flex-wrap:wrap;">
				<span style="flex-shrink:0; font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; background:rgba(74,222,128,0.15); border:1px solid rgba(74,222,128,0.5); color:var(--text-primary); white-space:nowrap;">${escapeHtml(localizeFormat('usage.skillSuggestions.repeated', cluster.sessionCount))}</span>
				<div style="flex:1; min-width:200px; font-size:12px; color:var(--text-primary); font-style:italic; overflow-wrap:anywhere;"><q>${escapeHtml(cluster.representativePrompt)}</q></div>
				<div style="display:flex; gap:6px; flex-shrink:0;">
					<button type="button" class="skill-suggestion-create" data-cluster-index="${clusterIndex}" title="${escapeHtml(localize('usage.skillSuggestions.createSkillTooltip'))}"
						style="font-size:11px; padding:3px 10px; border-radius:5px; border:1px solid var(--vscode-focusBorder); background:var(--vscode-button-secondaryBackground); color:var(--text-primary); cursor:pointer;">${escapeHtml(localize('usage.skillSuggestions.createSkill'))}</button>
					<button type="button" class="skill-suggestion-copy" data-cluster-index="${clusterIndex}" title="${escapeHtml(localize('usage.skillSuggestions.copyPromptTooltip'))}"
						style="font-size:11px; padding:3px 10px; border-radius:5px; border:1px solid transparent; background:var(--bg-tertiary); color:var(--text-primary); cursor:pointer;">${escapeHtml(localize('usage.skillSuggestions.copyPrompt'))}</button>
				</div>
			</div>
			${keywords}
			<div style="margin-top:6px; font-size:11px; color:var(--text-secondary);">${escapeHtml(buildTargetHint(cluster))}</div>
			<div class="skill-suggestion-notice" data-cluster-index="${clusterIndex}" role="status" aria-live="polite" aria-atomic="true"></div>
			<details style="margin-top:8px;">
				<summary style="font-size:11px; color:var(--text-secondary); cursor:pointer;">${escapeHtml(localizeFormat('usage.skillSuggestions.sessions', cluster.sessions.length))}</summary>
				<div style="margin-top:4px;">${renderSkillSessionsTable(cluster, clusterIndex)}</div>
			</details>
		</div>`;
}

/**
 * The suggestion list: a one-column, headerless data table of cards, five per
 * page; the pager is left out entirely when everything fits on one page. Rows
 * keep the report's order (largest first), so a row's index is its cluster index.
 */
function renderSuggestionList(report: RepeatedTaskReport): string {
	return renderDataTable({
		tableId: SKILL_SUGGESTIONS_LIST_ID,
		ariaLabel: localize('usage.skillSuggestions.pagerLabel'),
		rows: report.clusters,
		columns: [{ id: 'suggestion', label: localize('usage.skillSuggestions.pagerLabel'), render: (cluster, index) => ({ html: buildClusterCardHtml(cluster, index) }) }],
		showHeader: false,
		pageSize: report.clusters.length > SKILL_SUGGESTIONS_PAGE_SIZE ? SKILL_SUGGESTIONS_PAGE_SIZE : false,
		rootClassName: 'skill-suggestions-list',
	});
}

/** Inner HTML of the section: title, subtitle and the paged card list. */
export function buildSkillSuggestionsBodyHtml(report: RepeatedTaskReport): string {
	return `
		<div class="section-title"><span>🧩</span><span>${escapeHtml(localizeFormat('usage.skillSuggestions.title', report.clusters.length))}</span></div>
		<div class="section-subtitle">${escapeHtml(localizeFormat('usage.skillSuggestions.subtitle', report.sessionsScanned))}</div>
		${renderSuggestionList(report)}`;
}

/** "Skill suggestions" section for the Tools & Integrations tab (empty string when no candidates). */
export function buildSkillSuggestionsSectionHtml(report: RepeatedTaskReport | null): string {
	if (!report || report.clusters.length === 0) { return ''; }
	// Announces copy feedback; paging and sorting are announced by each data table's own region.
	return `<div class="section" id="${SKILL_SUGGESTIONS_SECTION_ID}">
		<span class="data-table-status skill-suggestions-status" role="status" aria-live="polite" aria-atomic="true"></span>
		${buildSkillSuggestionsBodyHtml(report)}
	</div>`;
}

// ── Interaction ────────────────────────────────────────────────────────────

/**
 * Whether a repository (an `owner/repo` display name) is one of the open
 * workspace folders, matched by folder name. No open folders means not open.
 */
export function isRepositoryOpen(repository: string, workspacePaths: readonly string[]): boolean {
	const repoName = repository.split('/').filter(Boolean).pop()?.toLowerCase();
	if (!repoName) { return false; }
	return workspacePaths.some(p => p.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() === repoName);
}

export type SkillSuggestionsMessage =
	| { command: 'draftCopilotChatWithPrompt'; prompt: string }
	| { command: 'openSessionFile'; file: string };

export type SkillCreateAction =
	| { kind: 'draft'; prompt: string }
	| { kind: 'openRepoFirst'; repository: string; prompt: string };

/**
 * Decide what "Create skill with Copilot" does: draft the prompt, or — for a
 * single-repository suggestion whose repository is not open — explain that it
 * has to be opened first, so the skill is not written into the wrong place.
 */
export function resolveSkillCreateAction(cluster: RepeatedTaskCluster, workspacePaths: readonly string[]): SkillCreateAction {
	const prompt = buildSkillCreationPrompt(cluster);
	const target = resolveSkillTarget(cluster);
	if (target.kind === 'workspace' && !isRepositoryOpen(target.repository, workspacePaths)) {
		return { kind: 'openRepoFirst', repository: target.repository, prompt };
	}
	return { kind: 'draft', prompt };
}

export interface SkillSuggestionsWiring {
	getReport: () => RepeatedTaskReport | null;
	getWorkspacePaths: () => readonly string[];
	postMessage: (message: SkillSuggestionsMessage) => void;
}

function clusterAt(wiring: SkillSuggestionsWiring, button: Element): RepeatedTaskCluster | undefined {
	const index = Number(button.getAttribute('data-cluster-index'));
	return Number.isSafeInteger(index) && index >= 0 ? wiring.getReport()?.clusters[index] : undefined;
}

/** Announce a change that does not move focus (copy feedback, page changes) to screen readers. */
function announce(section: HTMLElement, text: string): void {
	const status = section.querySelector<HTMLElement>('.skill-suggestions-status');
	if (status) { status.textContent = text; }
}

function copyWithFeedback(section: HTMLElement, button: HTMLButtonElement, text: string): void {
	// Guarded and wrapped: a missing clipboard API, or a writeText that throws
	// synchronously, would otherwise escape the promise .catch() below.
	let write: Promise<void>;
	try {
		if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') { return; }
		write = navigator.clipboard.writeText(text);
	} catch {
		return;
	}
write.then(() => {
		button.textContent = localize('usage.skillSuggestions.copied');
		announce(section, localize('usage.skillSuggestions.copied'));
		setTimeout(() => { button.textContent = localize('usage.skillSuggestions.copyPrompt'); }, 2000);
	}).catch(() => { /* clipboard unavailable: leave the label unchanged */ });
}

function showOpenRepoNotice(section: HTMLElement, button: Element, action: Extract<SkillCreateAction, { kind: 'openRepoFirst' }>): void {
	const index = button.getAttribute('data-cluster-index');
	const notice = Array.from(section.querySelectorAll<HTMLElement>('.skill-suggestion-notice'))
		.find(n => n.getAttribute('data-cluster-index') === index);
	if (!notice) { return; }
	const repoFolderName = action.repository.split('/').filter(Boolean).pop() ?? action.repository;
	setHtml(notice, `
		<div style="margin-top:8px; padding:10px; background:rgba(251,191,36,0.07); border:1px solid rgba(251,191,36,0.4); border-radius:4px; display:flex; flex-direction:column; gap:8px;">
			<div style="font-size:11px; color:var(--warning-fg, var(--text-primary));">${escapeHtml(localizeFormat('usage.skillSuggestions.openRepoFirst', repoFolderName))}</div>
			<pre style="font-size:10px; color:var(--text-secondary); background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:4px; padding:8px; white-space:pre-wrap; word-break:break-word; max-height:160px; overflow-y:auto; font-family:monospace; margin:0;">${escapeHtml(action.prompt)}</pre>
		</div>`);
}

function handleSectionClick(section: HTMLElement, wiring: SkillSuggestionsWiring, target: Element): void {
	const openButton = target.closest<HTMLButtonElement>('button.skill-suggestion-open-session');
	if (openButton) {
		const file = openButton.getAttribute('data-file');
		if (file) { wiring.postMessage({ command: 'openSessionFile', file }); }
		return;
	}
	const createButton = target.closest<HTMLButtonElement>('button.skill-suggestion-create');
	if (createButton) {
		const cluster = clusterAt(wiring, createButton);
		if (!cluster) { return; }
		const action = resolveSkillCreateAction(cluster, wiring.getWorkspacePaths());
		if (action.kind === 'draft') {
			wiring.postMessage({ command: 'draftCopilotChatWithPrompt', prompt: action.prompt });
		} else {
			showOpenRepoNotice(section, createButton, action);
		}
		return;
	}
	const copyButton = target.closest<HTMLButtonElement>('button.skill-suggestion-copy');
	if (copyButton) {
		const cluster = clusterAt(wiring, copyButton);
		if (cluster) { copyWithFeedback(section, copyButton, buildSkillCreationPrompt(cluster)); }
	}
}

/**
 * Attach one delegated click listener to the section, so buttons keep working
 * across page changes and table re-renders. Safe to call after every render.
 */
export function wireSkillSuggestions(wiring: SkillSuggestionsWiring): void {
	const section = document.getElementById(SKILL_SUGGESTIONS_SECTION_ID);
	if (!section || section.dataset.skillSuggestionsWired === 'true') { return; }
	section.dataset.skillSuggestionsWired = 'true';
	section.addEventListener('click', event => {
		if (event.target instanceof Element) { handleSectionClick(section, wiring, event.target); }
	});
}
