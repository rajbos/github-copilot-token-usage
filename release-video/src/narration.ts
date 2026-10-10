/**
 * Writing the spoken script.
 *
 * ## The problem this solves
 *
 * The catalog's text is written to be **read on a screen, next to the thing it
 * describes**. The reader can already see which view they are on, so the entry
 * never says; and because it sits under a heading, it opens mid-thought:
 *
 *   > Corrections tab
 *   > Shows the moments where things went sideways...
 *
 * Narrated verbatim that becomes "Corrections tab: a new tab. Shows the
 * moments where things went sideways" — a label read aloud, then a sentence
 * with no subject. It sounds like a machine reading a changelog, because that
 * is exactly what it is.
 *
 * ## What a listener needs instead
 *
 * A listener has none of the page context, so the narration has to supply it:
 * where we are, what appeared there, and then what it does — as connected
 * sentences, with the subject restored.
 *
 *   > Over in the Usage Analysis view, there's a new tab called Corrections.
 *   > It shows the moments where things went sideways...
 *
 * The location comes from the harness registry (see `surfaces.ts`), so it uses
 * the same words that are on screen. The connective depends on what the
 * previous scene showed — moving to a different view is announced, staying on
 * one is not, and a tour that says "Over in..." eight times running sounds as
 * mechanical as the labels it replaced.
 */

import type { ResolvedFeature, ResolvedRelease } from './catalog';
import { tabName, viewName } from './surfaces';
import { toSpokenText } from './speech';

export interface NarrationContext {
	/** Position of this feature among the body scenes. */
	readonly index: number;
	/** The view the previous body scene was showing, if any. */
	readonly previousView?: string;
}

/**
 * Turns a catalog entry into spoken narration.
 */
export function featureNarration(feature: ResolvedFeature, context: NarrationContext): string {
	const sentences = [
		locationSentence(feature, context),
		describeBehaviour(feature.description),
	].filter(Boolean);

	return toSpokenText(sentences.join(' '));
}

/* ------------------------------------------------------- where and what */

/**
 * "Over in the Usage Analysis view, there's a new tab called Corrections."
 *
 * The opener is chosen from position and continuity rather than at random, so
 * the same release always narrates the same way — a video that rewords itself
 * on every run cannot be reviewed.
 */
function locationSentence(feature: ResolvedFeature, context: NarrationContext): string {
	const { index, previousView } = context;
	const view = viewName(feature.surface.view);
	const sameView = previousView === feature.surface.view;

	// A feature that *is* a whole new view has nowhere to be "in".
	if (feature.kind === 'view') {
		return index === 0
			? `First up, there's an entirely new view: ${view}.`
			: `There's also an entirely new view, called ${view}.`;
	}


	const opener = sameView
		? pick(['Staying in', 'Still in', 'Also in'], index)
		: index === 0
			? 'Starting in'
			: pick(['Over in', 'Next, in', 'Moving to'], index);

	const place = `${opener} the ${view} view`;
	const tab = feature.surface.tab ? tabName(feature.surface.view, feature.surface.tab) : null;

	if (feature.kind === 'tab') {
		// The tab's own name comes from the registry rather than from the
		// catalog title. The catalog writes nested tabs the way the UI draws
		// them — "Research → TTFT" — and an arrow read aloud becomes "Research
		// then TTFT", which is not what anyone calls it.
		const name = tab?.leaf ?? bareName(feature.title);
		const under = tab?.parent ? `, under ${tab.parent}` : '';
		return `${place}, there's a new tab called ${name}${under}.`;
	}

	// A section sits on a tab, so the tab is part of the address.
	if (!tab) {
		return `${place}, there's a new section called ${bareName(feature.title)}.`;
	}
	const under = tab.parent ? `, under ${tab.parent},` : '';
	return `${place}, on the ${tab.leaf} tab${under} there's a new section called ${bareName(feature.title)}.`;
}

/**
 * Strips a trailing surface word from a feature title.
 *
 * Catalog titles are written to stand alone in a list ("Corrections tab"), but
 * the sentence around them already supplies the noun — otherwise the narration
 * says "a new tab called Corrections tab".
 */
function bareName(title: string): string {
	return title.replace(/\s+(tab|view|section|panel)$/i, '').trim() || title;
}

/* ------------------------------------------------------------- behaviour */

/**
 * Rewrites the catalog description into a sentence with a subject.
 *
 * Catalog entries take a few recognisable shapes, all of which lean on the
 * heading above them. Each is given back the "it" the heading used to supply.
 * Anything unrecognised is passed through untouched — a slightly stiff
 * sentence is a much better failure than a mangled one.
 */
export function describeBehaviour(description: string): string {
	const text = description.trim();

	// "A new section on the Tools tab showing how much..." — the first half
	// repeats what the location sentence just said, so only the half after
	// "showing" survives.
	const selfDescribing = text.match(
		/^(?:an?\s+)?new\s+(?:section|tab|view)\b[^.]*?\b(?:showing|that shows|which shows|listing|that lists)\s+(.+)$/is,
	);
	if (selfDescribing?.[1]) {
		return `It shows ${lowerFirst(selfDescribing[1])}`;
	}

	// "A new tab in the Diagnostics view. It does X." — drop the redundant
	// opening sentence and keep the rest.
	const redundantOpener = text.match(/^(?:an?\s+)?new\s+(?:section|tab|view)\b[^.]*\.\s+(.+)$/is);
	if (redundantOpener?.[1]) {
		return redundantOpener[1];
	}

	// "Shows the moments where..." / "Lists conversations from..." — a verb
	// with the subject stripped off by the heading.
	const headlessVerb = text.match(
		/^(Shows|Lists|Clusters|Groups|Tracks|Counts|Surfaces|Displays|Reports|Highlights|Reconstructs|Adds|Records)\b(.+)$/is,
	);
	if (headlessVerb?.[1] && headlessVerb[2]) {
		return `It ${headlessVerb[1].toLowerCase()}${headlessVerb[2]}`;
	}

	// "How long each model takes to..." — a noun phrase answering a question.
	if (/^(How|What|Which|Where|When)\b/i.test(text) && !/^When\s+(a|an|the|you|your)\b/i.test(text)) {
		return `It shows ${lowerFirst(text)}`;
	}

	// "When a Copilot CLI session runs on..." — already a full sentence.
	return text;
}

/* ----------------------------------------------------------- the bookends */

/**
 * The cold open, spoken over a real screen before the logo appears.
 *
 * This carries the headline, which is the longest piece of narration in the
 * script. It belongs here rather than on the logo card because the headline
 * takes fifteen to twenty seconds to read, and a static logo held that long
 * reads as a stall. Over a live screen it is a title sequence.
 */
export function coldOpenNarration(release: ResolvedRelease, productName: string): string {
	return toSpokenText(`This is ${productName}, version ${release.version}. ${release.headline}`);
}

/**
 * Spoken over the logo card.
 *
 * One short line, so the sting is a beat rather than a pause: the card is on
 * screen for about as long as it takes to say this, and no longer.
 */
export function introNarration(_release: ResolvedRelease, _productName: string): string {
	return toSpokenText(`Let's take a look at what is new.`);
}

export function outroNarration(count: number, productName: string): string {
	const summary = count === 1
		? 'That is the one change in this release'
		: `That is all ${count} changes in this release`;

	// Spoken over the download card, so it ends on where to get it rather than
	// on a recap. The card itself carries the URL — the narration should not
	// try to read one out.
	return toSpokenText(
		`${summary}. Every one of them is listed in the What's New view inside the extension. ` +
		`${productName} is available from all of these marketplaces, and the source is on GitHub. ` +
		`Thanks for watching.`,
	);
}

/* -------------------------------------------------------------- utilities */

/** Deterministic rotation through a set of phrasings. */
function pick(options: readonly string[], index: number): string {
	return options[index % options.length] ?? options[0] ?? '';
}

/** Lowercases the first letter unless the word looks like a name or acronym. */
function lowerFirst(text: string): string {
	const trimmed = text.trim();
	const firstWord = trimmed.split(/\s+/)[0] ?? '';
	// "TTFT ..." or "Copilot ..." must keep their capital; "How long ..." must not.
	if (/^[A-Z]{2,}/.test(firstWord) || /^[A-Z][a-z]+[A-Z]/.test(firstWord)) {
		return trimmed;
	}
	return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
