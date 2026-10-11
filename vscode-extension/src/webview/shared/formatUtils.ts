import type { TokenEstimator } from '../../../../src/types';
import { EDITOR_ICON_MAP as _EDITOR_ICON_MAP, getEditorIconByName } from '../../editorIcons';
import { getWindowData } from '../../../../src/webview/shared/dataLoader';

const _estimatorsData = getWindowData<{ estimators: Record<string, number> }>('__TOKEN_ESTIMATORS__');
const tokenEstimators: Record<string, TokenEstimator> = _estimatorsData?.estimators ?? {};
let currentLocale: string | undefined;
let compactNumbersEnabled = true;

/**
 * Sets an optional locale used by format helpers.
 * When undefined, runtime default locale is used.
 */
export function setFormatLocale(locale?: string): void {
	currentLocale = locale;
}

/**
 * Sets whether compact number formatting (K/M suffixes) is enabled.
 * When disabled, formatCompact falls back to formatNumber.
 */
export function setCompactNumbers(enabled: boolean): void {
	compactNumbersEnabled = enabled;
}

/** Union of all known editor display names that have explicit icon mappings. */
export type EditorName = keyof typeof _EDITOR_ICON_MAP;

/**
 * Re-export canonical map for callers that need the full record.
 * The authoritative source is `src/editorIcons.ts`.
 */
export const EDITOR_ICON_MAP: Record<string, string> = _EDITOR_ICON_MAP;

/**
 * Returns an icon for a given editor name.
 * Falls back to '📝' for editors not present in the map.
 * Delegates to the canonical {@link getEditorIconByName} in `src/editorIcons.ts`.
 */
export function getEditorIcon(editor: string): string {
	return getEditorIconByName(editor);
}

/**
 * Returns the approximate characters per token for a given model.
 */
export function getCharsPerToken(model: string): number {
	const ratio = tokenEstimators[model] ?? 0.25;
	return 1 / ratio;
}

/**
 * Formats a number to a fixed number of decimal places.
 */
export function formatFixed(value: number, digits: number): string {
	return new Intl.NumberFormat(currentLocale, {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	}).format(value);
}

/**
 * Formats a number as a percentage with one decimal place.
 */
export function formatPercent(value: number, digits = 1): string {
	return `${formatFixed(value, digits)}%`;
}

/**
 * Formats a number with locale-specific thousand separators.
 */
export function formatNumber(value: number): string {
	return value.toLocaleString(currentLocale);
}

/**
 * Formats a number with K/M suffixes for compact display (e.g. 1,500 → 1.5K, 1,200,000 → 1.2M).
 * Numbers below 1,000 are shown without a suffix.
 * Falls back to formatNumber when compact numbers are disabled via setCompactNumbers(false).
 */
export function formatCompact(value: number): string {
	if (!compactNumbersEnabled) {
		return formatNumber(value);
	}
	return new Intl.NumberFormat(currentLocale, {
		notation: 'compact',
		maximumFractionDigits: 1
	}).format(value);
}

/**
 * Formats a number as a USD cost with 2 decimal places.
 */
export function formatCost(value: number): string {
	return new Intl.NumberFormat(currentLocale, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	}).format(value);
}

/**
 * Locale-aware signed USD amount with a fixed number of fraction digits.
 * `Intl` places both the sign and the currency symbol, so the result stays
 * correct in locales that write `US$ -0,0037` rather than `-$0.0037`.
 * Zero carries no sign.
 */
function formatSignedCostWithDigits(value: number, digits: number): string {
	return new Intl.NumberFormat(currentLocale, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		signDisplay: 'exceptZero'
	}).format(value);
}

/**
 * Formats a signed USD cost effect at full precision (four fraction digits),
 * for tooltips and other places where the exact amount matters more than
 * brevity — e.g. `+$7.3500`.
 */
export function formatSignedCostPrecise(value: number): string {
	return formatSignedCostWithDigits(value, 4);
}

/**
 * Formats a signed USD cost effect for compact display: two fraction digits,
 * widening to four when a non-zero effect would otherwise round away to
 * `$0.00` and read as "no change at all" — e.g. `-$0.0037`.
 */
export function formatSignedCostCompact(value: number): string {
	const roundsToZero = value !== 0 && Math.abs(value) < 0.005;
	return formatSignedCostWithDigits(value, roundsToZero ? 4 : 2);
}

/**
 * Escapes HTML special characters in a string to prevent XSS.
 */
export function escapeHtml(text: string): string {
	// Host payloads are untyped at runtime; a missing field must render empty, not throw and
	// abort the whole panel render (matches `escapeHtml` in src/utils/html.ts).
	return String(text ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Runs a section-html builder and isolates failures so one broken section can never blank
 * out an entire page render. If `builder` throws, the error is logged (via `onError`, e.g.
 * `console.error`) and a small inline error card is returned in its place instead of letting
 * the exception propagate up through the surrounding template literal (which would otherwise
 * abort the whole `root.innerHTML` assignment and leave every other section stuck on stale or
 * blank content).
 */
export function safeSectionHtml(
	label: string,
	builder: () => string,
	onError: (message: string) => void = (m) => console.error(m),
): string {
	try {
		return builder();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onError(`[usage-webview] Section "${label}" failed to render: ${message}`);
		return `<div class="section" style="border-color: rgba(239, 68, 68, 0.3);">
			<div class="section-title"><span>⚠️</span><span>${escapeHtml(label)}</span></div>
			<div style="color: var(--text-secondary); font-size: 12px; padding: 8px 0;">
				This section couldn't be displayed due to an unexpected error. Other sections are unaffected — try refreshing the dashboard.
			</div>
		</div>`;
	}
}

/**
 * Formats a byte count as a human-readable file size string.
 */
export function formatFileSize(bytes: number): string {
	const numericBytes = Number(bytes);
	if (!Number.isFinite(numericBytes) || numericBytes < 0) {
		return 'N/A';
	}
	if (numericBytes < 1024) {
		return `${numericBytes} B`;
	}
	// Scale through binary units, picking the largest that keeps the value >= 1.
	const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
	let value = numericBytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	// Keep KB at 1 decimal (small, noisy); MB and up at 2 decimals.
	const decimals = unitIndex === 0 ? 1 : 2;
	return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/**
 * Formats a duration in milliseconds as a short string like "12m" or "1h 04m".
 * Returns "—" when the value is missing, non-finite, or negative.
 */
export function formatDurationShort(durationMs?: number): string {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
		return '—';
	}
	const totalMinutes = Math.round(durationMs / 60000);
	if (totalMinutes < 1) {
		return '<1m';
	}
	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * Returns a human-readable "time since" string for an ISO timestamp.
 */
export function getTimeSince(isoString: string): string {
	try {
		const now = Date.now();
		const then = new Date(isoString).getTime();
		if (!Number.isFinite(then)) {
			return 'Unknown';
		}
		const diffMs = now - then;

		if (diffMs < 0) {
			return 'Just now';
		}

		const seconds = Math.floor(diffMs / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) {
			return `${days} day${days !== 1 ? 's' : ''} ago`;
		}
		if (hours > 0) {
			return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
		}
		if (minutes > 0) {
			return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
		}
		return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
	} catch {
		return 'Unknown';
	}
}

/**
 * Formats a timestamp as a locale-aware absolute date (e.g. "Sep 14, 2026"). Accepts an ISO
 * string, epoch milliseconds, or a `Date` directly so callers with a raw `mtimeMs` number don't
 * need an extra `new Date(ms).toISOString()` round-trip just to hand this a string.
 * Unlike {@link getTimeSince}, this is deterministic (does not depend on `Date.now()`)
 * and honors the caller's locale, making it safe for fixture-driven screenshots.
 * Returns "—" when the value is missing or invalid.
 */
export function formatAbsoluteDate(input: string | number | Date): string {
	const then = input instanceof Date ? input : new Date(input);
	if (!Number.isFinite(then.getTime())) {
		return '—';
	}
	return then.toLocaleDateString(currentLocale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Converts markdown links to HTML anchor tags while escaping other HTML.
 * Converts [text](url) to <a href="url" target="_blank" rel="noopener noreferrer">text</a>
 */
export function markdownToHtml(text: string): string {
	let escaped = escapeHtml(text);
	escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
	return escaped;
}

/** Maps stage number (1–4) to its display label. */
export const STAGE_LABELS: Record<number, string> = {
	1: 'Stage 1: AI Skeptic',
	2: 'Stage 2: AI Explorer',
	3: 'Stage 3: AI Collaborator',
	4: 'Stage 4: AI Strategist'
};

/** Maps stage number (1–4) to a one-line description of that stage. */
export const STAGE_DESCRIPTIONS: Record<number, string> = {
	1: 'Rarely uses AI tools or uses only basic features',
	2: 'Exploring AI capabilities with occasional use',
	3: 'Regular, purposeful use across multiple features',
	4: 'Strategic, advanced use leveraging the full AI ecosystem'
};
