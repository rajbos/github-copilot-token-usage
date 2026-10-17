import { getWindowData } from './dataLoader';

type PricingEntry = { displayNames?: string[] };

// Build display name map from pricing JSON injected by the extension host as window.__MODEL_PRICING__.
// This is the single source of truth so it stays in sync with the nightly JSON refresh.
const _pricingData = getWindowData<{ pricing: Record<string, PricingEntry> }>('__MODEL_PRICING__');
// Null-prototype: model ids come from session data, so a model literally named
// `constructor`, `toString` or `valueOf` would otherwise hit Object.prototype and
// resolve to a *function* instead of a display name — which then throws inside
// escapeHtml() and takes the whole view's render down with it.
const _modelNames: Record<string, string> = Object.create(null);
for (const [modelId, pricing] of Object.entries((_pricingData?.pricing ?? {}) as Record<string, PricingEntry>)) {
    if (pricing.displayNames && pricing.displayNames.length > 0) {
        _modelNames[modelId] = pricing.displayNames[0];
    }
}

/**
 * Display names for Copilot's synthetic routers, which have no pricing entry
 * (each turn is billed at the rate of whichever real model served it).
 */
const ROUTER_DISPLAY_NAMES: Record<string, string> = Object.assign(Object.create(null), {
    hydrafusion: 'HydraFusion',
    auto: 'Auto',
});

/** Suffix appended to the user-chosen provider name so custom endpoints are recognizable as such. */
const CUSTOM_PROVIDER_SUFFIX = ' (Custom)';

/**
 * A model served by a user-configured custom endpoint (BYOK), parsed from its
 * three-part model identifier.
 */
export interface CustomProviderModel {
    /** The host/extension that registered the endpoint, e.g. `customendpoint`, `unify-chat-provider`. */
    source: string;
    /** The provider name the user typed when registering the endpoint, e.g. `Mistral`. */
    providerName: string;
    /** The model identifier sent to the endpoint, e.g. `mistral-medium-latest`. */
    modelId: string;
}

/** URI-decodes a single model-ID segment, falling back to the raw text when it is malformed. */
function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Parses a custom-endpoint model identifier.
 *
 * Models added through a user-configured endpoint (VS Code "custom endpoint" / BYOK,
 * unify-chat-provider, …) arrive as three slash-separated parts:
 *
 *   `<source>/<user-chosen provider name>/<model id>`
 *   e.g. `customendpoint/Mistral/mistral-medium-latest`
 *
 * Both the provider name and the model id are free text typed by the user, so the
 * two are only split apart when all three parts are present — a plain model id
 * (`gpt-4o`) or a two-part id is left untouched.
 *
 * @returns the parsed parts, or `undefined` when the id is not a three-part custom-endpoint id.
 */
export function parseCustomProviderModel(model: string): CustomProviderModel | undefined {
    const parts = model.split('/');
    if (parts.length !== 3 || parts.some(part => part.trim() === '')) { return undefined; }
    return {
        source: decodeSegment(parts[0]),
        providerName: decodeSegment(parts[1]),
        modelId: decodeSegment(parts[2]),
    };
}

/** Matches a leading `<uuid>/` prefix, e.g. org-scoped Copilot model catalog ids. */
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

/**
 * Returns candidate model ids to try when looking up a raw model id in the
 * pricing JSON, most specific first. Handles the id variants seen in session
 * logs that all refer to the same underlying model:
 *
 * - `copilot/` prefix stripping
 * - custom-endpoint ids (`<source>/<provider>/<model>`) → the model part
 * - org-scoped Copilot catalog ids (`<uuid>/<model>`) → the model part
 * - dash-separated version numbers (`claude-opus-4-8` → `claude-opus-4.8`),
 *   applied to each of the above
 */
export function getModelLookupCandidates(model: string): string[] {
	const candidates: string[] = [];
	const add = (id: string) => { if (id && !candidates.includes(id)) { candidates.push(id); } };
	const addWithVersionVariant = (id: string) => {
		add(id);
		// Some logs emit version numbers dash-separated (claude-opus-4-8) where the
		// pricing JSON uses dots (claude-opus-4.8). Only convert the first
		// digit-dash-digit run so date suffixes (…-4-5-20251001) stay intact.
		add(id.replace(/(\d+)-(\d+)(?=-|$)/, '$1.$2'));
	};

	const base = model.replace(/^copilot\//, '');
	addWithVersionVariant(base);
	const custom = parseCustomProviderModel(base);
	if (custom) { addWithVersionVariant(custom.modelId); }
	if (UUID_PREFIX.test(base)) { addWithVersionVariant(base.replace(UUID_PREFIX, '')); }
	return candidates;
}

/**
 * Returns the provider group for a custom-endpoint model — the user-chosen provider
 * name marked as custom, e.g. `Mistral (Custom)` for
 * `customendpoint/Mistral/mistral-medium-latest`.
 *
 * @returns `undefined` for models that do not come from a custom endpoint.
 */
export function getCustomProviderGroup(model: string): string | undefined {
    const parsed = parseCustomProviderModel(model);
    return parsed ? `${parsed.providerName}${CUSTOM_PROVIDER_SUFFIX}` : undefined;
}

/** Whether a provider/billing group name was produced by `getCustomProviderGroup`. */
export function isCustomProviderGroup(group: string): boolean {
    return group.endsWith(CUSTOM_PROVIDER_SUFFIX);
}

/**
 * Returns a human-friendly display name for a given model identifier.
 *
 * Custom-endpoint ids are reduced to their model part (the user-chosen provider
 * name is surfaced separately as a provider group), so
 * `customendpoint/Mistral/mistral-medium-latest` displays as the friendly name of
 * `mistral-medium-latest`. Org-scoped catalog ids (`<uuid>/model`) and
 * dash/dot version variants are resolved via `getModelLookupCandidates`.
 *
 * If the model ID is not in the pricing JSON, it falls back to URI-decoding
 * the raw ID (e.g. unify-chat-provider names contain %20-encoded segments),
 * with known prefix forms (custom endpoint, org UUID) stripped.
 */
export function getModelDisplayName(model: string): string {
    if (ROUTER_DISPLAY_NAMES[model]) { return ROUTER_DISPLAY_NAMES[model]; }
    for (const candidate of getModelLookupCandidates(model)) {
    	const name = _modelNames[candidate];
    	if (typeof name === 'string' && name) { return name; }
    }
    const custom = parseCustomProviderModel(model);
    if (custom) { return custom.modelId; }
    if (UUID_PREFIX.test(model)) { return model.replace(UUID_PREFIX, ''); }
    return decodeSegment(model);
}
