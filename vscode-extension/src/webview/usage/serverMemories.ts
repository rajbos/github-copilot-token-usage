/**
 * Copilot **server-side** repository memories — the Tools-tab section and its payload guard.
 *
 * Split out of `main.ts` rather than added to it: that file sits just under the repository's
 * 6000-line `max-lines` ceiling (see AGENTS.md), and a new section is exactly the kind of
 * growth that is supposed to become a module instead.
 *
 * See `src/copilotServerMemories.ts` for where this data comes from, and
 * `docs/features/COPILOT-SERVER-MEMORIES.md` for why it is analyzed rather than just listed.
 */
import type {
	ServerMemoriesAnalysisView,
	ServerMemoryDocumentedEntryView,
	ServerMemoryPromotionGroupView,
	ServerMemoryPromotionTarget,
} from '../../../../src/types';
import { renderDataTable, type DataTableColumn } from '../shared/dataTable';
import { escapeHtml, formatNumber } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';

export const SERVER_MEMORIES_TABLE_ID = 'server-memories-promotion';
export const SERVER_MEMORIES_DOCUMENTED_TABLE_ID = 'server-memories-documented';

/**
 * Messages this section posts to the extension host. The promote button sends only the group's
 * subject key, never prompt text: the host rebuilds the prompt and re-probes the target file at
 * click time, so a button rendered from an hour-old analysis cannot aim an agent at a path that
 * has since become unsafe.
 */
export type ServerMemoriesMessage =
	| { command: 'draftServerMemoryPromotion'; subject: string; fingerprint: string }
	| { command: 'openServerMemoryCitation'; path: string };

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const optionalString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function sanitizePromotionGroups(raw: unknown): ServerMemoryPromotionGroupView[] {
	if (!Array.isArray(raw)) { return []; }
	return raw
		.filter(group => group && typeof group.displaySubject === 'string' && typeof group.representativeFact === 'string')
		.map(group => {
			const view: ServerMemoryPromotionGroupView = {
				displaySubject: group.displaySubject,
				representativeFact: group.representativeFact,
				repeatCount: count(group.repeatCount),
				citationCount: count(group.citationCount),
			};
			const prompt = optionalString(group.prompt);
			if (prompt) { view.prompt = prompt; }
			const subject = optionalString(group.subject);
			if (subject) { view.subject = subject; }
			const fingerprint = optionalString(group.fingerprint);
			if (fingerprint) { view.fingerprint = fingerprint; }
			return view;
		});
}

function sanitizeDocumentedMemories(raw: unknown): ServerMemoryDocumentedEntryView[] {
	if (!Array.isArray(raw)) { return []; }
	return raw
		.filter(entry => entry && typeof entry.subject === 'string' && typeof entry.fact === 'string')
		.map(entry => ({
			subject: entry.subject,
			fact: entry.fact,
			files: Array.isArray(entry.files)
				? entry.files
					.filter((file: unknown) => file && typeof (file as { path?: unknown }).path === 'string')
					.map((file: { path: string; openable?: unknown; missing?: unknown }) => ({
						path: file.path,
						...(file.openable === true ? { openable: true } : {}),
						...(file.missing === true ? { missing: true } : {}),
					}))
				: [],
		}));
}

function sanitizePromotionTarget(raw: unknown): ServerMemoryPromotionTarget | undefined {
	if (!raw || typeof raw !== 'object') { return undefined; }
	const target = raw as Partial<ServerMemoryPromotionTarget>;
	if (target.path !== 'AGENTS.md' && target.path !== '.github/copilot-instructions.md') { return undefined; }
	return { path: target.path, exists: target.exists === true };
}

/**
 * Normalize the optional server-memories projection so rendering never throws on a partial
 * payload. Unlike `_sanitizeMemoryFilesAnalysis` in `main.ts` an *empty* analysis is still kept:
 * a repository with memory switched off, or one whose store could not be read, has no
 * groups to show but does have a reason worth rendering.
 *
 * The scope, target and documented-list fields are optional, so a payload from an older
 * host (or cache) still renders — just without them.
 */
export function sanitizeServerMemoriesAnalysis(raw: unknown): ServerMemoriesAnalysisView | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const sm = raw as Partial<ServerMemoriesAnalysisView>;
	if (typeof sm.repo !== 'string') { return null; }
	return {
		repo: sm.repo,
		// Tri-state on purpose: `undefined` means the enablement check failed, which is not
		// the same as the repository having memory switched off.
		enabled: typeof sm.enabled === 'boolean' ? sm.enabled : undefined,
		error: typeof sm.error === 'string' ? sm.error : undefined,
		truncated: sm.truncated === true,
		totalMemories: count(sm.totalMemories),
		distinctSubjects: count(sm.distinctSubjects),
		documentedCount: count(sm.documentedCount),
		promotionCandidateCount: count(sm.promotionCandidateCount),
		repeatedGroupCount: count(sm.repeatedGroupCount),
		fullyStaleCount: count(sm.fullyStaleCount),
		topPromotionGroups: sanitizePromotionGroups(sm.topPromotionGroups),
		repoRoot: optionalString(sm.repoRoot),
		workspaceFolderCount: count(sm.workspaceFolderCount),
		promotionTarget: sanitizePromotionTarget(sm.promotionTarget),
		documentedMemories: sanitizeDocumentedMemories(sm.documentedMemories),
	};
}

/**
 * Localize a template and escape it, then splice in pre-built HTML for its placeholders —
 * so a value can be emphasized without letting the translation itself carry markup.
 */
function localizeWithHtml(key: string, ...htmlArgs: string[]): string {
	const marker = (i: number) => `\u0001${i}\u0001`;
	const escaped = escapeHtml(localizeFormat(key, ...htmlArgs.map((_, i) => marker(i))));
	return escaped.replace(/\u0001(\d+)\u0001/g, (match, index) => htmlArgs[Number(index)] ?? match);
}

const BUTTON = 'font-size:11px; padding:2px 8px; cursor:pointer; white-space:nowrap;';

/** Which repository, which checkout, and why that is not "this workspace". */
function buildScopeHtml(analysis: ServerMemoriesAnalysisView): string {
	const repo = `<strong>${escapeHtml(analysis.repo)}</strong>`;
	const scope = analysis.repoRoot
		? localizeWithHtml('serverMemories.scope', repo, `<code>${escapeHtml(analysis.repoRoot)}</code>`)
		: localizeWithHtml('serverMemories.scopeNoPath', repo);
	const multiRoot = (analysis.workspaceFolderCount ?? 0) > 1
		? `<div>${escapeHtml(localizeFormat('serverMemories.multiRootNote', analysis.workspaceFolderCount ?? 0))}</div>`
		: '';
	return `<div class="server-memories-scope" style="margin-bottom:8px; font-size:12px; color:var(--text-secondary);">
		<div>${scope}</div>
		${multiRoot}
		<div>${escapeHtml(localize('serverMemories.localVsServer'))}</div>
	</div>`;
}

type PromotionGroup = ServerMemoriesAnalysisView['topPromotionGroups'][number];
type DocumentedEntry = NonNullable<ServerMemoriesAnalysisView['documentedMemories']>[number];

function buildPromoteBlockHtml(analysis: ServerMemoriesAnalysisView): string {
	if (analysis.topPromotionGroups.length === 0) { return ''; }
	const warn = 'var(--vscode-editorWarning-foreground, #cca700)';
	const target = analysis.promotionTarget;
	// A row gets the button only when the host projected a prompt for it (promotion groups with a
	// safe target) and the subject key the host needs to rebuild that prompt at click time.
	const canDraft = (group: PromotionGroup): boolean => Boolean(group.prompt && group.subject && group.fingerprint);
	const hasActions = analysis.topPromotionGroups.some(canDraft);
	const columns: DataTableColumn<PromotionGroup>[] = [
		{
			id: 'subject', label: localize('serverMemories.table.subject'), sortValue: group => group.displaySubject,
			render: group => {
				// Only a repeat is worth calling out — a badge reading "re-learned 1x" would add
				// noise to every single-sighting row without saying anything.
				const badge = group.repeatCount > 1
					? ` <span style="color:${warn}; font-size:11px;">(${escapeHtml(localizeFormat('serverMemories.repeatBadge', group.repeatCount))})</span>`
					: '';
				return { html: `<span style="white-space:nowrap;">${escapeHtml(group.displaySubject)}${badge}</span>` };
			},
		},
		{ id: 'fact', label: localize('serverMemories.table.fact'), sortValue: group => group.representativeFact, render: group => group.representativeFact },
		{ id: 'sources', label: localize('serverMemories.table.sources'), align: 'right', sortValue: group => group.citationCount, render: group => String(group.citationCount) },
	];
	if (hasActions) {
		columns.push({
			id: 'action', label: localize('serverMemories.table.action'), align: 'right',
			render: group => ({
				html: canDraft(group)
					? `<button class="server-memory-draft-btn" data-subject="${escapeHtml(group.subject ?? '')}" data-fingerprint="${escapeHtml(group.fingerprint ?? '')}" style="${BUTTON}" title="${escapeHtml(localizeFormat('serverMemories.askCopilotTooltip', target?.path ?? 'AGENTS.md'))}">${escapeHtml(localize('serverMemories.askCopilot'))}</button>`
					: '',
			}),
		});
	}
	const targetNote = target
		? ` ${localizeWithHtml(target.exists ? 'serverMemories.targetExisting' : 'serverMemories.targetNew', `<code>${escapeHtml(target.path)}</code>`)}`
		: '';
	// No initialSort: the host already ranks the groups by how worth promoting they are.
	return `
		<div style="margin-top:10px; font-size:13px; font-weight:600; color:var(--text-primary);">${escapeHtml(localize('serverMemories.promoteHeading'))}</div>
		<div style="margin-bottom:8px; font-size:12px; color:var(--text-secondary);">${escapeHtml(localize('serverMemories.promoteHint'))}${targetNote}</div>
		${renderDataTable({
			tableId: SERVER_MEMORIES_TABLE_ID,
			ariaLabel: localize('serverMemories.promoteHeading'),
			rows: analysis.topPromotionGroups,
			columns,
		})}`;
}

function buildDocumentedBlockHtml(analysis: ServerMemoriesAnalysisView): string {
	const entries = analysis.documentedMemories ?? [];
	if (entries.length === 0) { return ''; }
	const columns: DataTableColumn<DocumentedEntry>[] = [
		{ id: 'subject', label: localize('serverMemories.table.subject'), sortValue: entry => entry.subject, render: entry => ({ html: `<span style="white-space:nowrap;">${escapeHtml(entry.subject)}</span>` }) },
		{ id: 'fact', label: localize('serverMemories.table.fact'), sortValue: entry => entry.fact, render: entry => entry.fact },
		{
			id: 'files', label: localize('serverMemories.table.citedFile'),
			render: entry => ({
				html: entry.files.map(file => {
					// No "Open file" for a citation that was not a regular file inside this checkout;
					// a missing one is marked, since it no longer documents the fact. The button
					// sends the repo-relative path and the host re-validates it on click.
					const open = file.openable
						? ` <button class="server-memory-open-btn" data-path="${escapeHtml(file.path)}" style="${BUTTON}">${escapeHtml(localize('serverMemories.openFile'))}</button>`
						: '';
					const missing = file.missing
						? ` <span class="server-memory-missing" style="color:var(--vscode-editorWarning-foreground, #cca700); font-size:11px;">(${escapeHtml(localize('serverMemories.citedFileMissing'))})</span>`
						: '';
					return `<div><code>${escapeHtml(file.path)}</code>${missing}${open}</div>`;
				}).join(''),
			}),
		},
	];
	const showing = analysis.documentedCount > entries.length
		? ` (${escapeHtml(localizeFormat('serverMemories.showingOf', formatNumber(entries.length), formatNumber(analysis.documentedCount)))})`
		: '';
	return `
		<div style="margin-top:14px; font-size:13px; font-weight:600; color:var(--text-primary);">${escapeHtml(localize('serverMemories.documentedHeading'))}${showing}</div>
		<div style="margin-bottom:8px; font-size:12px; color:var(--text-secondary);">${escapeHtml(localize('serverMemories.documentedHint'))}</div>
		${renderDataTable({
			tableId: SERVER_MEMORIES_DOCUMENTED_TABLE_ID,
			ariaLabel: localize('serverMemories.documentedHeading'),
			rows: entries,
			columns,
			className: 'server-memories-documented',
		})}`;
}

/**
 * Render this repository's server-side Copilot memories.
 *
 * The section leads with the promotion candidates rather than a full list of the store:
 * a live repository can hold hundreds of memories, and reading them all is what the
 * GitHub settings page is for. What this view adds is the part that page cannot show —
 * which facts the agent keeps re-deriving from code because no instruction file states
 * them, which are already written down, and which memories now cite files that are gone.
 *
 * Renders nothing at all when the workspace is not a GitHub repository (`analysis` is
 * null), but *does* render when the store is empty or unreadable, since "memory is off
 * for this repo" is itself the answer to the question the section asks.
 */
export function buildServerMemoriesSectionHtml(analysis: ServerMemoriesAnalysisView | null | undefined): string {
	try {
		if (!analysis) { return ''; }

		const header = `
			<div class="section-title"><span>🧠</span><span>${escapeHtml(localize('serverMemories.sectionTitle'))}</span></div>
			<div class="section-subtitle" style="color:var(--text-primary); opacity:0.75;">${escapeHtml(localize('serverMemories.sectionSubtitle'))}</div>`;

		// The scope is shown in every state, not just a successful read: "which repository failed,
		// or has Memory turned off?" is exactly what these states must answer.
		if (analysis.error) {
			return `<div id="section-server-memories" class="section">${header}
				${buildScopeHtml(analysis)}
				<div style="font-size:13px; color:var(--text-secondary);">${escapeHtml(localizeFormat('serverMemories.unavailable', analysis.error))}</div>
			</div>`;
		}
		if (analysis.enabled === false) {
			return `<div id="section-server-memories" class="section">${header}
				${buildScopeHtml(analysis)}
				<div style="font-size:13px; color:var(--text-secondary);">${escapeHtml(localize('serverMemories.disabled'))}</div>
			</div>`;
		}

		const warn = 'var(--vscode-editorWarning-foreground, #cca700)';
		return `
			<!-- Server Memories Section -->
			<div id="section-server-memories" class="section">
				${header}
				${buildScopeHtml(analysis)}
				<div style="margin-bottom:8px; font-size:13px; color:var(--text-primary);">
					${escapeHtml(localizeFormat('serverMemories.summary', formatNumber(analysis.totalMemories), formatNumber(analysis.distinctSubjects)))}
					${analysis.truncated ? ` · <span title="${escapeHtml(localize('serverMemories.truncatedTooltip'))}">${escapeHtml(localize('serverMemories.truncated'))}</span>` : ''}
					${analysis.documentedCount > 0 ? ` · ${escapeHtml(localizeFormat(analysis.documentedCount === 1 ? 'serverMemories.documentedSummaryOne' : 'serverMemories.documentedSummary', analysis.documentedCount))}` : ''}
					${analysis.fullyStaleCount > 0 ? ` · <span style="color:${warn};">${escapeHtml(localizeFormat(analysis.fullyStaleCount === 1 ? 'serverMemories.staleSummaryOne' : 'serverMemories.staleSummary', analysis.fullyStaleCount))}</span>` : ''}
				</div>
				${buildPromoteBlockHtml(analysis)}
				${buildDocumentedBlockHtml(analysis)}
			</div>`;
	} catch (error) {
		console.error(`[usage-webview] buildServerMemoriesSectionHtml failed: ${error instanceof Error ? error.message : String(error)}`);
		return `
			<div id="section-server-memories" class="section">
				<div class="section-title"><span>🧠</span><span>${escapeHtml(localize('serverMemories.sectionTitle'))}</span></div>
				<div class="section-subtitle" style="color:var(--text-primary); opacity:0.75;">${escapeHtml(localize('serverMemories.renderError'))}</div>
			</div>`;
	}
}

/**
 * Map a click inside the section to the host message it should send, or `null`. Split from
 * the listener so it can be unit-tested without a DOM event loop.
 *
 * The "Ask Copilot" button asks the host to *draft* the prompt (never submit it): the prompt
 * embeds agent-written memory text, so a person reviews it first.
 */
export function serverMemoriesMessageForClick(eventTarget: EventTarget | null): ServerMemoriesMessage | null {
	const target = asElement(eventTarget);
	const draft = target?.closest<HTMLElement>('.server-memory-draft-btn');
	const subject = draft?.getAttribute('data-subject');
	const fingerprint = draft?.getAttribute('data-fingerprint');
	if (subject && fingerprint) { return { command: 'draftServerMemoryPromotion', subject, fingerprint }; }
	const open = target?.closest<HTMLElement>('.server-memory-open-btn');
	const path = open?.getAttribute('data-path');
	if (path) { return { command: 'openServerMemoryCitation', path }; }
	return null;
}

/**
 * Normalize a click's `event.target` to an element. It is not always one: a click can land on a
 * Text node (e.g. a button's label), which has no `closest()`. Such a node resolves to its parent
 * element, so a click on a label still reaches its button; anything else yields `null`.
 * Duck-typed rather than `instanceof Element`, so it works across documents and realms.
 */
function asElement(eventTarget: EventTarget | null): Element | null {
	if (!eventTarget) { return null; }
	if (typeof (eventTarget as Element).closest === 'function') { return eventTarget as Element; }
	return (eventTarget as Node).parentElement ?? null;
}

/**
 * Wire the section's buttons with one delegated listener. Safe to call after every render:
 * a section element that is already wired is skipped (same `data-*` guard as
 * `wireCurationButtons` in `main.ts`), so a render that keeps the element cannot stack a
 * second listener and post every click twice. A rebuilt section is a new element and is
 * wired afresh.
 */
export function wireServerMemoriesButtons(postMessage: (message: ServerMemoriesMessage) => void): void {
	const section = document.getElementById('section-server-memories');
	if (!section || section.dataset.serverMemoriesWired === 'true') { return; }
	section.dataset.serverMemoriesWired = 'true';
	section.addEventListener('click', event => {
		const message = serverMemoriesMessageForClick(event.target);
		if (message) { postMessage(message); }
	});
}
