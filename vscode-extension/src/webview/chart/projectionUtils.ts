export type ChartPeriod = 'day' | 'week' | 'month';

/**
 * Returns the fraction (0–1) of the current period that has elapsed.
 * Uses minute-level precision.
 *
 * @param period The chart period type.
 * @param now    Override the current date/time (defaults to new Date()). Used in tests.
 */
export function getCurrentPeriodFraction(period: ChartPeriod, now?: Date): number {
	const d = now ?? new Date();
	const dayFrac = (d.getHours() * 60 + d.getMinutes()) / (24 * 60);

	if (period === 'day') {
		return Math.max(0, Math.min(1, dayFrac));
	}
	if (period === 'week') {
		// ISO week: Mon=0, Tue=1, ... Sun=6
		const isoWeekDay = (d.getDay() + 6) % 7;
		return Math.max(0, Math.min(1, (isoWeekDay + dayFrac) / 7));
	}
	// month
	const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
	return Math.max(0, Math.min(1, (d.getDate() - 1 + dayFrac) / daysInMonth));
}

/**
 * Computes the additional (projected remaining) value to show on top of the current period bar.
 * Returns null when projection is not applicable:
 *   - no actual usage yet (actual <= 0)
 *   - period barely started (fraction < 1%)
 *   - period essentially complete (fraction >= 99.5%)
 *   - projected extra would round to zero
 *
 * @param actual   Actual value so far for the current period.
 * @param fraction Fraction of the period elapsed (0–1) from getCurrentPeriodFraction.
 */
export function computeProjectionExtra(actual: number, fraction: number): number | null {
	if (actual <= 0 || fraction < 0.01 || fraction >= 0.995) { return null; }
	const extra = actual / fraction - actual;
	return extra > 0 ? extra : null;
}
