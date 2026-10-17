// Pure helpers behind the Details view's "Cost by Provider" filter. Kept free of DOM
// access so the rules deciding which providers can be filtered (and which saved
// exclusions actually apply) are unit-testable.

export const ALL_PERIODS = ['today', 'last30Days', 'month', 'lastMonth'] as const;

type ProviderPeriod = { billingGroupCosts?: Record<string, number> };
export type ProviderStats = Record<typeof ALL_PERIODS[number], ProviderPeriod>;

/** Returns every billing-group (provider) name seen across all four periods, "GitHub Copilot" first. */
export function getAllProviders(stats: ProviderStats): string[] {
	const set = new Set<string>();
	ALL_PERIODS.forEach(period => {
		Object.keys(stats[period].billingGroupCosts ?? {}).forEach(p => set.add(p));
	});
	return Array.from(set).sort((a, b) => {
		if (a === 'GitHub Copilot') { return -1; }
		if (b === 'GitHub Copilot') { return 1; }
		return a.localeCompare(b);
	});
}

/**
 * Providers that get a card in the "Cost by Provider" panel (those with cost this month).
 * With zero or one such provider the panel adds no value (nothing to compare or filter)
 * and is hidden, so this returns an empty list — meaning no provider can be filtered out.
 */
export function getFilterableProviders(stats: ProviderStats): string[] {
	const providersWithMonthlyCost = getAllProviders(stats).filter(provider => (stats.month.billingGroupCosts?.[provider] ?? 0) > 0);
	return providersWithMonthlyCost.length > 1 ? providersWithMonthlyCost : [];
}

/**
 * The subset of saved exclusions that actually applies: only providers that have a card in
 * the visible panel. A saved exclusion for a provider with no card (or with the panel hidden
 * entirely) cannot be seen or undone, so it must not silently zero out totals (issue #2198).
 */
export function getActiveExcludedProviders(savedExclusions: Iterable<string>, filterableProviders: string[]): Set<string> {
	return new Set(Array.from(savedExclusions).filter(p => filterableProviders.includes(p)));
}
