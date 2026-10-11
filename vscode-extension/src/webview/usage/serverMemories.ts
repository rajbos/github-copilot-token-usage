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
import type { ServerMemoriesAnalysisView } from '../../../../src/types';
import { renderDataTable, type DataTableColumn } from '../shared/dataTable';
import { escapeHtml, formatNumber } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';

export const SERVER_MEMORIES_TABLE_ID = 'server-memories-promotion';

/**
 * Normalize the optional server-memories projection so rendering never throws on a partial
 * payload. Unlike `_sanitizeMemoryFilesAnalysis` in `main.ts` an *empty* analysis is still kept:
 * a repository with memory switched off, or one whose store could not be read, has no
 * groups to show but does have a reason worth rendering.
 */
export function sanitizeServerMemoriesAnalysis(raw: unknown): ServerMemoriesAnalysisView | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const sm = raw as Partial<ServerMemoriesAnalysisView>;
	if (typeof sm.repo !== 'string') { return null; }
	const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
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
		topPromotionGroups: Array.isArray(sm.topPromotionGroups)
			? sm.topPromotionGroups
				.filter(group => group && typeof group.displaySubject === 'string' && typeof group.representativeFact === 'string')
				.map(group => ({
					displaySubject: group.displaySubject,
					representativeFact: group.representativeFact,
					repeatCount: count(group.repeatCount),
					citationCount: count(group.citationCount),
				}))
			: [],
	};
}


/**
 * Render this repository's server-side Copilot memories.
 *
 * The section leads with the promotion candidates rather than a full list of the store:
 * a live repository can hold hundreds of memories, and reading them all is what the
 * GitHub settings page is for. What this view adds is the part that page cannot show —
 * which facts the agent keeps re-deriving from code because no instruction file states
 * them, and which memories now cite files that are gone.
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

		if (analysis.error) {
			return `<div id="section-server-memories" class="section">${header}
				<div style="font-size:13px; color:var(--text-secondary);">${escapeHtml(localizeFormat('serverMemories.unavailable', analysis.error))}</div>
			</div>`;
		}
		if (analysis.enabled === false) {
			return `<div id="section-server-memories" class="section">${header}
				<div style="font-size:13px; color:var(--text-secondary);">${escapeHtml(localize('serverMemories.disabled'))}</div>
			</div>`;
		}

		const warn = 'var(--vscode-editorWarning-foreground, #cca700)';
		type PromotionGroup = ServerMemoriesAnalysisView['topPromotionGroups'][number];
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

		// No initialSort: the host already ranks the groups by how worth promoting they are.
		const promoteBlock = analysis.topPromotionGroups.length === 0 ? '' : `
			<div style="margin-top:10px; font-size:13px; font-weight:600; color:var(--text-primary);">${escapeHtml(localize('serverMemories.promoteHeading'))}</div>
			<div style="margin-bottom:8px; font-size:12px; color:var(--text-secondary);">${escapeHtml(localize('serverMemories.promoteHint'))}</div>
			${renderDataTable({
				tableId: SERVER_MEMORIES_TABLE_ID,
				ariaLabel: localize('serverMemories.promoteHeading'),
				rows: analysis.topPromotionGroups,
				columns,
			})}`;

		return `
			<!-- Server Memories Section -->
			<div id="section-server-memories" class="section">
				${header}
				<div style="margin-bottom:8px; font-size:13px; color:var(--text-primary);">
					${escapeHtml(localizeFormat('serverMemories.summary', formatNumber(analysis.totalMemories), formatNumber(analysis.distinctSubjects)))}
					${analysis.truncated ? ` · <span title="${escapeHtml(localize('serverMemories.truncatedTooltip'))}">${escapeHtml(localize('serverMemories.truncated'))}</span>` : ''}
					${analysis.documentedCount > 0 ? ` · ${escapeHtml(localizeFormat('serverMemories.documentedSummary', analysis.documentedCount))}` : ''}
					${analysis.fullyStaleCount > 0 ? ` · <span style="color:${warn};">${escapeHtml(localizeFormat('serverMemories.staleSummary', analysis.fullyStaleCount))}</span>` : ''}
				</div>
				${promoteBlock}
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
