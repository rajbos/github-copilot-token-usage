/**
 * Declarative catalog of what shipped in each release, in plain English.
 *
 * This file is the single source of truth for two things:
 *
 *   1. The **What's New** view — it renders the most recent
 *      {@link WHATS_NEW_MAX_RELEASES} entries below as readable prose. It is
 *      deliberately *not* the CHANGELOG: the changelog is written for people
 *      reading a diff ("Fix `Other` row sorting into the top-N list"), this is
 *      written for someone who just wants to know what they can now do.
 *   2. The one-at-a-time "new here" notifications — every entry in `features`
 *      names the exact surface it added, so the announcer can skip anything
 *      the user already found on their own, and the notification's button can
 *      open it.
 *
 * ## Adding a release
 *
 * Prepend a new {@link WhatsNewRelease} (newest first) when you bump the
 * extension version. Only list things a *user* can point at — a new view, a
 * new tab, a new section on an existing tab. Bug fixes and refactors belong in
 * the changelog, not here.
 *
 * Keep `features` short. The announcer only ever announces
 * {@link WHATS_NEW_MAX_ANNOUNCEMENTS_PER_RELEASE} of them per release, so a
 * list of ten is nine items of noise and one item of signal; put the ones that
 * matter first.
 *
 * Feature `id`s are persisted in globalState to remember what a user has
 * already been told. **Never reuse or renumber an id** — a recycled id silently
 * suppresses the announcement for everyone who saw the old feature.
 *
 * Run `node .github/skills/whats-new-catalog/whats-new-catalog.js` after editing:
 * it catches a missing entry for the current version, a surface pointing at a
 * view or tab that no longer exists, and features sitting below the
 * announcement cap. See `.github/skills/whats-new-catalog/SKILL.md`.
 */

/** The webview panels a feature can live in. Matches the esbuild entry point names. */
export type FeatureViewId =
	| 'details'
	| 'chart'
	| 'usage'
	| 'maturity'
	| 'efficiency'
	| 'environmental'
	| 'diagnostics'
	| 'logviewer'
	| 'fluency-level-viewer'
	| 'dashboard'
	| 'whatsnew';

/**
 * Where a feature lives, precise enough both to open it and to tell whether the
 * user has already been there.
 */
export interface FeatureSurface {
	/** The panel the feature lives in. */
	readonly view: FeatureViewId;
	/** Tab within that panel, when the panel has tabs (`data-tab` value). */
	readonly tab?: string;
	/** DOM id to scroll to once the tab is open, for section-level features. */
	readonly anchor?: string;
}

/**
 * What kind of thing was added. Only drives the wording of the notification
 * ("New view" / "New tab" / "New section"), so the toast reads naturally
 * without every catalog entry having to repeat itself.
 */
export type FeatureKind = 'view' | 'tab' | 'section';

export interface WhatsNewFeature {
	/** Stable id, persisted in globalState. Never reuse one. */
	readonly id: string;
	/**
	 * `package.nls.json` key for the short noun phrase as it reads in the UI
	 * ("Corrections tab"). A key, not the text: this module is pure — no `vscode`
	 * import — so it cannot resolve strings itself. `extension.ts` resolves them
	 * at the render boundary. See docs/adr/LOCALIZATION-ARCHITECTURE.md (S3).
	 */
	readonly titleKey: string;
	/** `package.nls.json` key for one or two sentences: what it shows and why you'd look. */
	readonly descriptionKey: string;
	readonly kind: FeatureKind;
	readonly surface: FeatureSurface;
}

export interface WhatsNewRelease {
	/** Extension version, e.g. `0.17.3`. */
	readonly version: string;
	/** Release date as `YYYY-MM-DD`, or `null` while the version is unreleased. */
	readonly date: string | null;
	/** `package.nls.json` key for one sentence summing the release up. */
	readonly headlineKey: string;
	readonly features: readonly WhatsNewFeature[];
}

/** How many releases the What's New view lists. */
export const WHATS_NEW_MAX_RELEASES = 5;

/** How many features from a single release may ever be announced as a toast. */
export const WHATS_NEW_MAX_ANNOUNCEMENTS_PER_RELEASE = 3;

/**
 * Stop announcing features from a release once it is this old, so someone
 * upgrading after a long break gets the What's New view rather than a fortnight
 * of daily toasts about things that are no longer news.
 */
export const WHATS_NEW_MAX_ANNOUNCEMENT_AGE_DAYS = 60;

/**
 * Releases, newest first. See the file header before editing.
 */
export const WHATS_NEW_RELEASES: readonly WhatsNewRelease[] = [
	{
		version: '0.19.1',
		date: null,
		headlineKey: 'whatsNew.release.0.19.1.headline',
		features: [
			{
				id: 'usage.tool-execution-stats',
				titleKey: 'whatsNew.feature.usage.tool-execution-stats.title',
				descriptionKey: 'whatsNew.feature.usage.tool-execution-stats.description',
				kind: 'section',
				surface: { view: 'usage', tab: 'tools', anchor: 'section-tool-reliability' },
			},
			{
				id: 'whatsnew.view-index',
				titleKey: 'whatsNew.feature.whatsnew.view-index.title',
				descriptionKey: 'whatsNew.feature.whatsnew.view-index.description',
				kind: 'tab',
				surface: { view: 'whatsnew', tab: 'index' },
			},
		],
	},
	{
		version: '0.19.0',
		date: '2026-10-02',
		headlineKey: 'whatsNew.release.0.19.0.headline',
		features: [
			{
				id: 'usage.group-tabs',
				titleKey: 'whatsNew.feature.usage.group-tabs.title',
				descriptionKey: 'whatsNew.feature.usage.group-tabs.description',
				kind: 'section',
				surface: { view: 'usage' },
			},
		],
	},
	{
		version: '0.18.3',
		date: '2026-09-29',
		headlineKey: 'whatsNew.release.0.18.3.headline',
		features: [],
	},
	{
		version: '0.18.2',
		date: '2026-09-28',
		headlineKey: 'whatsNew.release.0.18.2.headline',
		features: [
			{
				id: 'usage.readiness-tab',
				titleKey: 'whatsNew.feature.usage.readiness-tab.title',
				descriptionKey: 'whatsNew.feature.usage.readiness-tab.description',
				kind: 'tab',
				surface: { view: 'usage', tab: 'readiness' },
			},
		],
	},
	{
		version: '0.18.1',
		date: '2026-09-21',
		headlineKey: 'whatsNew.release.0.18.1.headline',
		features: [],
	},
	{
		version: '0.18.0',
		date: '2026-09-18',
		headlineKey: 'whatsNew.release.0.18.0.headline',
		features: [
			{
				id: 'usage.memory-files-hygiene',
				titleKey: 'whatsNew.feature.usage.memory-files-hygiene.title',
				descriptionKey: 'whatsNew.feature.usage.memory-files-hygiene.description',
				kind: 'section',
				surface: { view: 'usage', tab: 'tools', anchor: 'section-memory-files' },
			},
			{
				id: 'logviewer.hydrafusion-routing',
				titleKey: 'whatsNew.feature.logviewer.hydrafusion-routing.title',
				descriptionKey: 'whatsNew.feature.logviewer.hydrafusion-routing.description',
				kind: 'section',
				surface: { view: 'logviewer', anchor: 'section-hydrafusion-routing' },
			},
			{
				id: 'usage.corrections-tab',
				titleKey: 'whatsNew.feature.usage.corrections-tab.title',
				descriptionKey: 'whatsNew.feature.usage.corrections-tab.description',
				kind: 'tab',
				surface: { view: 'usage', tab: 'corrections' },
			},
			{
				id: 'usage.skill-suggestions',
				titleKey: 'whatsNew.feature.usage.skill-suggestions.title',
				descriptionKey: 'whatsNew.feature.usage.skill-suggestions.description',
				kind: 'section',
				surface: { view: 'usage', tab: 'tools', anchor: 'section-skill-suggestions' },
			},
			{
				id: 'diagnostics.ttft-tab',
				titleKey: 'whatsNew.feature.diagnostics.ttft-tab.title',
				descriptionKey: 'whatsNew.feature.diagnostics.ttft-tab.description',
				kind: 'tab',
				surface: { view: 'diagnostics', tab: 'ttft' },
			},
			{
				// Listed last on purpose: the per-release cap means this is never
				// announced, and it does not need to be — the notification's second
				// button is a link to this very page.
				id: 'whatsnew.view',
				titleKey: 'whatsNew.feature.whatsnew.view.title',
				descriptionKey: 'whatsNew.feature.whatsnew.view.description',
				kind: 'view',
				surface: { view: 'whatsnew' },
			},
		],
	},
	{
		version: '0.17.2',
		date: '2026-08-17',
		headlineKey: 'whatsNew.release.0.17.2.headline',
		features: [],
	},
	{
		version: '0.17.1',
		date: '2026-07-31',
		headlineKey: 'whatsNew.release.0.17.1.headline',
		features: [],
	},
	{
		version: '0.17.0',
		date: '2026-07-30',
		headlineKey: 'whatsNew.release.0.17.0.headline',
		features: [
			{
				id: 'efficiency.view',
				titleKey: 'whatsNew.feature.efficiency.view.title',
				descriptionKey: 'whatsNew.feature.efficiency.view.description',
				kind: 'view',
				surface: { view: 'efficiency' },
			},
			{
				id: 'usage.model-efficiency',
				titleKey: 'whatsNew.feature.usage.model-efficiency.title',
				descriptionKey: 'whatsNew.feature.usage.model-efficiency.description',
				kind: 'section',
				surface: { view: 'usage', tab: 'activity', anchor: 'section-model-efficiency' },
			},
			{
				id: 'chart.cost-by-model-split',
				titleKey: 'whatsNew.feature.chart.cost-by-model-split.title',
				descriptionKey: 'whatsNew.feature.chart.cost-by-model-split.description',
				kind: 'section',
				surface: { view: 'chart' },
			},
		],
	},
	{
		version: '0.13.0',
		date: '2026-07-11',
		headlineKey: 'whatsNew.release.0.13.0.headline',
		features: [
			{
				id: 'usage.context-window',
				titleKey: 'whatsNew.feature.usage.context-window.title',
				descriptionKey: 'whatsNew.feature.usage.context-window.description',
				kind: 'section',
				surface: { view: 'usage', tab: 'activity' },
			},
		],
	},
];

/** Looks up a catalog feature by id. Returns `null` for an unknown id. */
export function findFeature(featureId: string): { feature: WhatsNewFeature; release: WhatsNewRelease } | null {
	for (const release of WHATS_NEW_RELEASES) {
		const feature = release.features.find((f) => f.id === featureId);
		if (feature) { return { feature, release }; }
	}
	return null;
}
