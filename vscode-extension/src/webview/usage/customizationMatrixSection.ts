import type { WorkspaceCustomizationMatrix, WorkspaceCustomizationRow } from '../../../../src/types';
import { getDataTableState, renderDataTable, renderDataTableFilter, type DataTableColumn } from '../shared/dataTable';
import { escapeHtml } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { statusBadgeHtml } from './statusBadge';

export const CUSTOMIZATION_TABLE_ID = 'customization';
export const CUSTOMIZATION_PAGE_SIZE = 20;
export const CUSTOMIZATION_FILTER_NONE_ONLY = 'noCustomizationOnly';

/** Also the What's New / search nav anchor (`usage.health.customization` in whatsNew/viewIndex.ts). */
const SECTION_ID = 'section-customization-files';

/**
 * Same test that decides the ⚠️ badge: every customization type is missing. A row with no
 * status data at all is unknown, not missing, so it is neither badged nor matched by the filter.
 */
export function hasNoCustomization(row: WorkspaceCustomizationRow): boolean {
	const statuses = Object.values(row.typeStatuses ?? {});
	return statuses.length > 0 && statuses.every(status => status === '❌');
}

/** Sort rank for a status cell: ✅ > ⚠️ > ❌; unknown sorts last in both directions. */
export function customizationStatusRank(status: string | undefined): number | null {
	if (status === '✅') { return 2; }
	if (status === '⚠️') { return 1; }
	if (status === '❌') { return 0; }
	return null;
}

function statusLabel(status: string): string {
	if (status === '✅') { return localize('usage.customization.status.fresh'); }
	if (status === '⚠️') { return localize('usage.customization.status.stale'); }
	if (status === '❌') { return localize('usage.customization.status.missing'); }
	return localize('usage.customization.status.unknown');
}

export function buildCustomizationColumns(matrix: WorkspaceCustomizationMatrix): DataTableColumn<WorkspaceCustomizationRow>[] {
	const typeColumns: DataTableColumn<WorkspaceCustomizationRow>[] = (matrix.customizationTypes ?? []).map(type => ({
		id: `type:${type.id}`,
		label: type.icon,
		headerTitle: type.label,
		align: 'center',
		width: '44px',
		sortValue: row => customizationStatusRank(row.typeStatuses?.[type.id]),
		render: row => {
			const status = row.typeStatuses?.[type.id] || '❓';
			return { html: statusBadgeHtml(status, statusLabel(status)) };
		},
	}));
	return [
		{
			id: 'workspace',
			label: localize('usage.customization.column.workspace'),
			sortValue: row => row.workspaceName,
			render: row => {
				const badge = hasNoCustomization(row)
					? ` <span style="font-family: sans-serif; vertical-align: middle;">${statusBadgeHtml('⚠️', localize('usage.customization.badge.noCustomization'))}</span>`
					: '';
				const title = row.workspacePath || row.workspaceName;
				return { html: `<span class="customization-workspace-name" title="${escapeHtml(title)}">${escapeHtml(row.workspaceName)}</span>${badge}` };
			},
		},
		{
			id: 'sessions',
			label: localize('usage.customization.column.sessions'),
			align: 'right',
			width: '96px',
			sortValue: row => row.sessionCount,
			render: row => String(row.sessionCount),
		},
		{
			id: 'interactions',
			label: localize('usage.customization.column.interactions'),
			align: 'right',
			width: '96px',
			sortValue: row => row.interactionCount,
			render: row => String(row.interactionCount),
		},
		...typeColumns,
	];
}

/** Renders only the paged table root, so sort/page/filter can swap it in place. */
export function renderCustomizationTable(matrix: WorkspaceCustomizationMatrix): string {
	return renderDataTable({
		tableId: CUSTOMIZATION_TABLE_ID,
		ariaLabel: localize('usage.customization.aria.table'),
		rows: matrix.workspaces,
		columns: buildCustomizationColumns(matrix),
		initialSort: { columnId: 'interactions', direction: 'desc' },
		defaultFilters: { [CUSTOMIZATION_FILTER_NONE_ONLY]: false },
		filterRows: (row, filters) => !filters[CUSTOMIZATION_FILTER_NONE_ONLY] || hasNoCustomization(row),
		pageSize: CUSTOMIZATION_PAGE_SIZE,
		className: 'data-table--fixed',
		rootClassName: 'data-table-root--scroll-y',
	});
}

function buildLegendHtml(matrix: WorkspaceCustomizationMatrix): string {
	return `
			<div style="margin-top: 12px; font-size: 10px; color: var(--text-muted); border-top: 1px solid var(--border-subtle); padding-top: 8px;">
				<div style="display: flex; gap: 16px; flex-wrap: wrap;">
					${(matrix.customizationTypes ?? []).map(type => `
						<span>${escapeHtml(type.icon)} ${escapeHtml(type.label)}</span>
					`).join('')}
				</div>
				<div style="margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
					<span style="display:inline-flex;align-items:center;gap:4px;">${statusBadgeHtml('✅', localize('usage.customization.status.fresh'))} ${escapeHtml(localize('usage.customization.legend.fresh'))}</span>
					<span style="color: var(--text-muted);">•</span>
					<span style="display:inline-flex;align-items:center;gap:4px;">${statusBadgeHtml('⚠️', localize('usage.customization.status.stale'))} ${escapeHtml(localize('usage.customization.legend.stale'))}</span>
					<span style="color: var(--text-muted);">•</span>
					<span style="display:inline-flex;align-items:center;gap:4px;">${statusBadgeHtml('❌', localize('usage.customization.status.missing'))} ${escapeHtml(localize('usage.customization.legend.missing'))}</span>
				</div>
			</div>`;
}

export function buildCustomizationSectionHtml(matrix: WorkspaceCustomizationMatrix | null): string {
	const currentMatrix = matrix && Array.isArray(matrix.workspaces) && matrix.workspaces.length > 0 ? matrix : null;
	if (!currentMatrix) {
		return `
			<div class="section" id="${SECTION_ID}">
				<div class="section-title"><span>🛠️</span><span>${escapeHtml(localize('usage.customization.title'))}</span></div>
				<div class="section-subtitle">${escapeHtml(localize('usage.customization.emptySubtitle'))}</div>
				<div style="color: var(--text-muted); padding:12px;">${escapeHtml(localize('usage.customization.empty'))}</div>
			</div>`;
	}
	const state = getDataTableState(CUSTOMIZATION_TABLE_ID, { sort: { columnId: 'interactions', direction: 'desc' }, filters: { [CUSTOMIZATION_FILTER_NONE_ONLY]: false } });
	const noneOnly = state.filters[CUSTOMIZATION_FILTER_NONE_ONLY] === true;
	// Keep the toggle while the filter is on, even if a refresh left no matching workspaces —
	// otherwise a persisted filter would hide every row with no way to turn it off.
	const filterToggle = currentMatrix.workspacesWithIssues > 0 || noneOnly
		? renderDataTableFilter({
			tableId: CUSTOMIZATION_TABLE_ID,
			filterId: CUSTOMIZATION_FILTER_NONE_ONLY,
			label: localize('usage.customization.filter.noCustomizationOnly'),
			checked: noneOnly,
		})
		: '';
	return `
		<div id="${SECTION_ID}" style="margin-top: 16px; margin-bottom: 16px; padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 6px;">
			<div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">
				🛠️ ${escapeHtml(localize('usage.customization.title'))}
			</div>
			<div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
				${escapeHtml(localizeFormat('usage.customization.summary', currentMatrix.totalWorkspaces))}
				${currentMatrix.workspacesWithIssues > 0
					? `<span class="stale-warning" style="display:inline-flex;align-items:center;gap:4px;">${statusBadgeHtml('⚠️', localize('usage.customization.badge.noCustomization'))} ${escapeHtml(localizeFormat('usage.customization.summary.issues', currentMatrix.workspacesWithIssues))}</span>`
					: `<span style="display:inline-flex;align-items:center;gap:4px;">${statusBadgeHtml('✅', localize('usage.customization.status.fresh'))} ${escapeHtml(localize('usage.customization.summary.allGood'))}</span>`}
			</div>
			${filterToggle}
			<div class="customization-matrix-container">
				${renderCustomizationTable(currentMatrix)}
			</div>
			${buildLegendHtml(currentMatrix)}
		</div>`;
}
