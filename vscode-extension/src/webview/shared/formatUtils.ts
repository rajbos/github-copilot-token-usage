// @ts-ignore
import tokenEstimatorsJson from '../../tokenEstimators.json';

const tokenEstimators: Record<string, number> = tokenEstimatorsJson.estimators;
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

/**
 * Returns an icon for a given editor name.
 */
export function getEditorIcon(editor: string): string {
	const icons: Record<string, string> = {
		'VS Code': '💙',
		'VS Code Insiders': '💚',
		'VS Code Exploration': '🧪',
		'VS Code Server': '☁️',
		'VS Code Server (Insiders)': '☁️',
		'VSCodium': '🔷',
		'Cursor': '⚡',
		'Copilot CLI': '🤖',
		'OpenCode': '🟢',
            'Visual Studio': '🪟',
		'Claude Code': '🟠',
		'Claude Desktop Cowork': '🟠',
		'Unknown': '❓'
	};
	return icons[editor] || '📝';
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
 * Formats a number as a USD cost with 4 decimal places.
 */
export function formatCost(value: number): string {
	return new Intl.NumberFormat(currentLocale, {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 4,
		maximumFractionDigits: 4
	}).format(value);
}
