// @ts-ignore — resolved by esbuild at bundle time
import modelPricingJson from '../../modelPricing.json';

type PricingEntry = { displayNames?: string[] };

// Build display name map from pricing JSON (first displayName = canonical friendly name).
// This is the single source of truth so it stays in sync with the nightly JSON refresh.
const _modelNames: Record<string, string> = {};
for (const [modelId, pricing] of Object.entries(modelPricingJson.pricing as Record<string, PricingEntry>)) {
    if (pricing.displayNames && pricing.displayNames.length > 0) {
        _modelNames[modelId] = pricing.displayNames[0];
    }
}

/**
 * Returns a human-friendly display name for a given model identifier.
 */
export function getModelDisplayName(model: string): string {
    return _modelNames[model] || model;
}