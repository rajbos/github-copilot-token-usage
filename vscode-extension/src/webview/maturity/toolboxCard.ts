import { escapeHtml, formatCompact, getEditorIcon } from '../shared/formatUtils';
import { PERIOD_LABELS, type Period } from '../shared/periodSelector';
import { socialShareButtonsHtml } from '../shared/socialShare';
import type { ShareCardPeriodData } from '../../shareCardData';

/** Id prefix of the toolbox card's social buttons (the score row keeps `btn-share`). */
export const TOOLBOX_SHARE_ID_PREFIX = 'btn-share-card';

/** Lowercase phrase describing a period, for use mid-sentence in the summary text. */
function periodPhrase(period: Period): string {
	return `in the ${PERIOD_LABELS[period].toLowerCase()}`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Plain-text version of the card, used by "Copy Summary Text". */
export function buildToolboxSummaryText(data: ShareCardPeriodData): string {
	const editorList = data.editors.map((e) => `${getEditorIcon(e.name)} ${e.name} (${e.sessions})`).join(', ');
	return `My AI Coding Toolbox — ${plural(data.editors.length, 'editor')} detected: ${editorList}. ` +
		`${data.sessions} sessions, ${data.interactions} interactions, ${formatCompact(data.tokens)} tokens ${periodPhrase(data.period)}. #AIEngineeringFluency`;
}

/** The card and its controls for one period. The period dropdown is mounted into `#toolbox-period-selector`. */
export function buildToolboxCardHtml(data: ShareCardPeriodData): string {
	const pills = data.editors
		.map((e) => `<div class="toolbox-pill"><span>${getEditorIcon(e.name)}</span><span>${escapeHtml(e.name)}</span><span class="toolbox-pill-count">${e.sessions}</span></div>`)
		.join('');
	const emptyNotice = data.sessions === 0
		? '<div class="toolbox-empty">No session activity in this period. Try a wider range.</div>'
		: '';
	return `
    <div class="toolbox-controls"><span class="toolbox-controls-label">Period:</span><span id="toolbox-period-selector"></span></div>
    <div class="toolbox-card">
      <div class="toolbox-badge">🤖 AI Engineering Fluency</div>
      <div class="toolbox-title">My AI Coding Toolbox</div>
      <div class="toolbox-subtitle">${escapeHtml(PERIOD_LABELS[data.period])} · ${plural(data.editors.length, 'editor')} detected</div>
      <div class="toolbox-pills">${pills}</div>
      <div class="toolbox-stats">
        <div class="toolbox-stat"><div class="toolbox-stat-value">${data.sessions}</div><div class="toolbox-stat-label">Sessions</div></div>
        <div class="toolbox-stat"><div class="toolbox-stat-value">${data.interactions}</div><div class="toolbox-stat-label">Interactions</div></div>
        <div class="toolbox-stat"><div class="toolbox-stat-value" title="${data.tokens.toLocaleString()} tokens">${formatCompact(data.tokens)}</div><div class="toolbox-stat-label">Tokens</div></div>
        <div class="toolbox-stat"><div class="toolbox-stat-value">${data.editors.length}</div><div class="toolbox-stat-label">Editors</div></div>
      </div>
    </div>
    ${emptyNotice}
    <div class="toolbox-actions"><button class="inline-action-btn" id="btn-copy-toolbox-summary">📋 Copy Summary Text</button></div>
    <div class="share-buttons toolbox-share-buttons">${socialShareButtonsHtml(TOOLBOX_SHARE_ID_PREFIX)}</div>`;
}
