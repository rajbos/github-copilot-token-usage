/**
 * UTC day key helpers.
 *
 * A "day key" is an ISO-8601 date string in UTC: YYYY-MM-DD.
 */

export function toUtcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function addDaysUtc(dayKey: string, daysToAdd: number): string {
	const date = new Date(`${dayKey}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + daysToAdd);
	return toUtcDayKey(date);
}

export function getDayKeysInclusive(startDayKey: string, endDayKey: string): string[] {
	const result: string[] = [];
	let current = startDayKey;
	while (current <= endDayKey) {
		result.push(current);
		if (current === endDayKey) {
			break;
		}
		current = addDaysUtc(current, 1);
	}
	return result;
}
