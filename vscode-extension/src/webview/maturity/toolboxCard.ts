import { escapeHtml, formatCompact, getEditorIcon } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { PERIOD_LABELS } from '../shared/periodSelector';
import { socialShareButtonsHtml } from '../shared/socialShare';
import type { ShareCardPeriodData } from '../../shareCardData';

/** Id prefix of the toolbox card's social buttons (the score row keeps `btn-share`). */
export const TOOLBOX_SHARE_ID_PREFIX = 'btn-share-card';

/** Phrase for use at the end of a sentence ("today", "in the last 30 days"). */
function periodPhrase(period: ShareCardPeriodData['period']): string {
	return localize(`share.toolbox.phrase.${period}`);
}

function editorsDetected(count: number): string {
	return count === 1 ? localize('share.toolbox.editorsDetectedOne') : localizeFormat('share.toolbox.editorsDetected', count);
}

/** Plain-text version of the card, used by "Copy Summary Text". */
export function buildToolboxSummaryText(data: ShareCardPeriodData): string {
	const editorList = data.editors.map((e) => `${getEditorIcon(e.name)} ${e.name} (${e.sessions})`).join(', ');
	const totals = [data.sessions, data.interactions, formatCompact(data.tokens), periodPhrase(data.period)] as const;
	return data.editors.length === 0
		? localizeFormat('share.toolbox.summaryNoEditors', editorsDetected(0), ...totals)
		: localizeFormat('share.toolbox.summary', editorsDetected(data.editors.length), editorList, ...totals);
}

/** The card and its controls for one period. The period dropdown is mounted into `#toolbox-period-selector`. */
export function buildToolboxCardHtml(data: ShareCardPeriodData): string {
	const pills = data.editors
		.map((e) => `<div class="toolbox-pill"><span>${getEditorIcon(e.name)}</span><span>${escapeHtml(e.name)}</span><span class="toolbox-pill-count">${e.sessions}</span></div>`)
		.join('');
	const emptyNotice = data.sessions === 0
		? `<div class="toolbox-empty">${escapeHtml(localize('share.toolbox.empty'))}</div>`
		: '';
	const stat = (value: string | number, labelKey: string, title?: string) =>
		`<div class="toolbox-stat"><div class="toolbox-stat-value"${title ? ` title="${escapeHtml(title)}"` : ''}>${value}</div><div class="toolbox-stat-label">${escapeHtml(localize(labelKey))}</div></div>`;
	return `
    <div class="toolbox-controls"><span class="toolbox-controls-label">${escapeHtml(localize('share.toolbox.period'))}</span><span id="toolbox-period-selector"></span></div>
    <div class="toolbox-card">
      <div class="toolbox-badge">${escapeHtml(localize('share.toolbox.badge'))}</div>
      <div class="toolbox-title">${escapeHtml(localize('share.toolbox.cardTitle'))}</div>
      <div class="toolbox-subtitle">${escapeHtml(PERIOD_LABELS[data.period])} · ${escapeHtml(editorsDetected(data.editors.length))}</div>
      <div class="toolbox-pills">${pills}</div>
      <div class="toolbox-stats">
        ${stat(data.sessions, 'share.toolbox.sessions')}
        ${stat(data.interactions, 'share.toolbox.interactions')}
        ${stat(escapeHtml(formatCompact(data.tokens)), 'share.toolbox.tokens', localizeFormat('share.toolbox.tokensTitle', data.tokens.toLocaleString()))}
        ${stat(data.editors.length, 'share.toolbox.editors')}
      </div>
    </div>
    ${emptyNotice}
    <div class="toolbox-actions"><button class="inline-action-btn" id="btn-copy-toolbox-summary">${escapeHtml(localize('share.toolbox.copy'))}</button></div>
    <div class="share-buttons toolbox-share-buttons">${socialShareButtonsHtml(TOOLBOX_SHARE_ID_PREFIX)}</div>`;
}
