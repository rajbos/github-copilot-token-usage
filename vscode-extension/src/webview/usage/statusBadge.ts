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
	const base = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;font-weight:700;flex-shrink:0;';
	if (status === '✅') {
		return `<span style="${base}background:rgba(34,197,94,0.2);border:1px solid rgba(34,197,94,0.5);color:#4ade80;font-size:12px;"${titleAttr} aria-label="${escapeHtml(label ?? localize('usage.customization.status.fresh'))}">✓</span>`;
	} else if (status === '⚠️') {
		return `<span style="${base}background:rgba(251,191,36,0.2);border:1px solid rgba(251,191,36,0.5);color:#fbbf24;font-size:12px;"${titleAttr} aria-label="${escapeHtml(label ?? localize('usage.customization.status.stale'))}">!</span>`;
	} else if (status === '❓') {
		return `<span style="${base}background:rgba(148,163,184,0.2);border:1px solid rgba(148,163,184,0.5);color:#94a3b8;font-size:12px;"${titleAttr} aria-label="${escapeHtml(label ?? localize('usage.customization.status.unknown'))}">?</span>`;
	} else {
		return `<span style="${base}background:rgba(239,68,68,0.2);border:1px solid rgba(239,68,68,0.5);color:#f87171;font-size:12px;"${titleAttr} aria-label="${escapeHtml(label ?? localize('usage.customization.status.missing'))}">✕</span>`;
	}
}
