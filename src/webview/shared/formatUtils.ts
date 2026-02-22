// @ts-ignore
import tokenEstimatorsJson from '../../tokenEstimators.json';

const tokenEstimators: Record<string, number> = tokenEstimatorsJson.estimators;
let currentLocale: string | undefined;

/**
 * Sets an optional locale used by format helpers.
 * When undefined, runtime default locale is used.
 */
export function setFormatLocale(locale?: string): void {
	currentLocale = locale;
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
