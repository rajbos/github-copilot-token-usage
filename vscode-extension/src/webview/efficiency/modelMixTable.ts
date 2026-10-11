// Renders the Efficiency view's "Model mix movement" table — the per-model token
// share behind the Cost Attribution tab's model-mix bar.
//
// A pure string builder with no CSS/DOM imports (same contract as
// logviewer/hydraFusionSection.ts) so the markup is unit-testable directly in
// Node, unlike main.ts.
//
// @security model identifiers come from session data and are therefore
// untrusted; every one of them goes through `escapeHtml` before rendering.

import { renderDataTable, type DataTableColumn } from '../shared/dataTable';
import { escapeHtml, formatFixed, formatPercent } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { getModelDisplayName } from '../../../../src/webview/shared/modelUtils';
import type { EfficiencyViewData, ModelMixShift } from '../../../../src/efficiencyAnalysis';

export const MODEL_MIX_TABLE_ID = 'efficiency-model-mix';

/**
 * Builds the model-mix movement table.
 *
 * Model names are resolved here rather than in `buildModelShifts()`: the
 * analytics layer keeps canonical ids, and `getModelDisplayName()` only has a
 * pricing map to resolve them against inside the webview, where the host
 * injects `window.__MODEL_PRICING__`. Unknown ids fall through that helper
 * unchanged, so a custom or brand-new model stays unique and inspectable
 * instead of being relabelled with a guess.
 *
 * The table is capped at a readable desktop width and keeps a minimum width, so
 * a narrow panel scrolls horizontally instead of squeezing the numbers out. Only
 * the model name truncates visually — its friendly and canonical forms both stay
 * available, through the cell's title and its screen-reader text.
 *
 * The 0.5-point noise threshold and the six-row cap are decided by
 * `buildModelShifts()`, and its row order is the default; the table never pages
 * (the cap bounds it) and only re-sorts when the reader clicks a header.
 */
export function renderModelMixTable(
	shifts: ModelMixShift[],
	windows: EfficiencyViewData['attributionWindows'],
): string {
	return `
		<h3 id="attr-shift-heading">${escapeHtml(localize('efficiency.modelMix.heading'))}</h3>
		${renderDataTable({
			tableId: MODEL_MIX_TABLE_ID,
			ariaLabel: localizeFormat('efficiency.modelMix.caption', windows.prevRange, windows.curRange),
			rows: shifts,
			columns: buildModelMixColumns(windows),
			pageSize: false,
			className: 'data-table--fixed attr-model-mix',
			rootClassName: 'attr-model-mix-root',
		})}`;
}

function periodHeader(labelKey: string, range: string): Pick<DataTableColumn<ModelMixShift>, 'label' | 'headerHtml'> {
	const label = localize(labelKey);
	return {
		label: `${label} ${range}`,
		headerHtml: `${escapeHtml(label)}<span class="th-sub">${escapeHtml(range)}</span>`,
	};
}

function buildModelMixColumns(windows: EfficiencyViewData['attributionWindows']): DataTableColumn<ModelMixShift>[] {
	return [
		{
			id: 'model',
			label: localize('efficiency.modelMix.model'),
			width: '40%',
			className: 'attr-shift-model',
			rowHeader: true,
			sortValue: shift => getModelDisplayName(shift.model),
			render: shift => ({ html: renderModelCell(shift) }),
		},
		{
			id: 'previous',
			...periodHeader('efficiency.modelMix.previous', windows.prevRange),
			align: 'right',
			width: '20%',
			className: 'eff-th-wrap',
			sortValue: shift => shift.prevShare,
			render: shift => formatPercent(shift.prevShare * 100),
		},
		{
			id: 'current',
			...periodHeader('efficiency.modelMix.current', windows.curRange),
			align: 'right',
			width: '20%',
			className: 'eff-th-wrap',
			sortValue: shift => shift.curShare,
			render: shift => formatPercent(shift.curShare * 100),
		},
		{
			id: 'shift',
			label: localize('efficiency.modelMix.shift'),
			align: 'right',
			width: '20%',
			sortValue: shift => shift.deltaShare,
			cellClassName: shift => (shift.deltaShare > 0 ? 'share-up' : 'share-down'),
			render: shift => localizeFormat('efficiency.modelMix.shiftPoints', `${shift.deltaShare > 0 ? '+' : ''}${formatFixed(shift.deltaShare * 100, 1)}`),
		},
	];
}

function renderModelCell(shift: ModelMixShift): string {
	const displayName = getModelDisplayName(shift.model);
	// When the friendly name already *is* the canonical id there is nothing extra
	// to disclose — repeating it would only make the screen-reader row noisier.
	const sameAsId = displayName === shift.model;
	const title = sameAsId ? displayName : `${displayName} — ${shift.model}`;
	// The leading space matters: without it the accessible name computation runs the
	// two spans together and the row is announced as "GPT-4oModel ID: gpt-4o".
	const canonical = sameAsId
		? ''
		: `<span class="attr-shift-sr"> ${escapeHtml(localizeFormat('efficiency.modelMix.canonicalId', shift.model))}</span>`;
	return `<span class="attr-shift-name" title="${escapeHtml(title)}">${escapeHtml(displayName)}</span>${canonical}`;
}
