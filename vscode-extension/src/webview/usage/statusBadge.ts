import { escapeHtml } from '../shared/formatUtils';
import { localize } from '../shared/localization';

/** A customization type's status as the host reports it. */
export type CustomizationTypeStatus = '✅' | '⚠️' | '❌';

/** What a badge can display: a reported status, or ❓ when the webview has no status for the type. */
export type StatusBadgeStatus = CustomizationTypeStatus | '❓';

/**
 * Returns a modern styled HTML badge for a status value, replacing plain emoji icons.
 * Pass/fresh → green ✓, warning/stale → amber !, unknown (❓) → grey ?, fail/missing → red ✕
 * Without a label, the aria-label falls back to the localized status name. Other callers pass
 * pass/fail emoji through as plain strings; any value that is not ✅, ⚠️ or ❓ renders as ✕.
 */
export function statusBadgeHtml(status: StatusBadgeStatus | string, label?: string): string {
	const titleAttr = label ? ` title="${escapeHtml(label)}"` : '';
	const badge = (modifier: string, glyph: string, fallbackKey: string): string =>
		`<span class="status-badge status-badge--${modifier}"${titleAttr} aria-label="${escapeHtml(label ?? localize(fallbackKey))}">${glyph}</span>`;
	if (status === '✅') {
		return badge('fresh', '✓', 'usage.customization.status.fresh');
	} else if (status === '⚠️') {
		return badge('stale', '!', 'usage.customization.status.stale');
	} else if (status === '❓') {
		return badge('unknown', '?', 'usage.customization.status.unknown');
	}
	return badge('missing', '✕', 'usage.customization.status.missing');
}
