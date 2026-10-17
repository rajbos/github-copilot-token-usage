/**
 * Turning written UI copy into something a voice can read.
 *
 * The catalog's descriptions are written to be *read on a screen*: they use
 * backticks for setting ids, arrows for navigation paths, markdown links and
 * em dashes. Fed verbatim to a TTS engine those become "backtick", "hyphen
 * greater-than" or a swallowed pause in the middle of a sentence.
 *
 * Two transforms, deliberately kept apart:
 *
 *   - {@link toSpokenText} normalizes notation into words. Its output is what
 *     the subtitles show, because it is still the true sentence.
 *   - {@link applyPronunciation} respells product names phonetically. Its
 *     output goes *only* to the TTS engine — a caption reading "Co-pilot
 *     C-L-I" would be wrong on screen.
 */

export interface PronunciationMap {
	/** Literal (case-insensitive) word or phrase -> how to say it. */
	readonly replacements: Readonly<Record<string, string>>;
}

/**
 * Normalizes screen notation into spoken English.
 *
 * Ordering matters: links are unwrapped before punctuation is touched, so a
 * URL's slashes and dots never reach the number/punctuation passes.
 */
export function toSpokenText(raw: string): string {
	let text = raw;

	// Markdown links -> their label. A URL is unreadable aloud and unwatchable.
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

	// `code` / setting ids -> plain words. Dotted setting paths get their dots
	// spoken as "dot" only when they are clearly an identifier, not a sentence end.
	text = text.replace(/`([^`]+)`/g, (_match, code: string) => code.replace(/\./g, ' dot '));

	// Navigation arrows and dashes.
	text = text
		.replace(/\s*(?:→|->|>)\s*/g, ' then ')
		.replace(/\s*—\s*/g, ', ')
		.replace(/\s*–\s*/g, ', ');

	// Ampersands come from UI labels like "Tools & Integrations".
	text = text.replace(/\s*&\s*/g, ' and ');

	// Bold/italic markers.
	text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');

	// Percentages and plus-signs read badly as symbols.
	text = text.replace(/(\d)\s*%/g, '$1 percent').replace(/(\d)\+/g, '$1 or more');

	// Parentheticals become their own clause rather than a silent aside.
	text = text.replace(/\s*\(([^)]{1,80})\)/g, ', $1,');

	// Collapse whitespace and tidy the punctuation the passes above created.
	// The parenthetical rule in particular can leave a comma butted against
	// another mark ("Mistral Cloud, Beta,: a new tab"), which reads as a stumble.
	text = text
		.replace(/\s+/g, ' ')
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/,\s*,/g, ',')
		.replace(/,\s*([.;:!?])/g, '$1')
		.replace(/([;:])\s*,/g, '$1')
		.trim();

	if (text && !/[.!?]$/.test(text)) {
		text += '.';
	}
	return text;
}

/**
 * Applies pronunciation overrides for the TTS engine only.
 *
 * Matching is whole-word and case-insensitive, longest key first so that
 * "Copilot CLI" wins over "Copilot".
 */
export function applyPronunciation(text: string, map: PronunciationMap | undefined): string {
	if (!map || !map.replacements) { return text; }
	const keys = Object.keys(map.replacements).sort((a, b) => b.length - a.length);
	let result = text;
	for (const key of keys) {
		const replacement = map.replacements[key];
		if (replacement === undefined) { continue; }
		const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'gi'), replacement);
	}
	return result;
}

/**
 * Splits text into sentences.
 *
 * A plain `[^.!?]+[.!?]+` split is wrong here in a way that is easy to miss:
 * release narration is full of version numbers, so "version 0.18.0." parses as
 * three sentences. Downstream that turned into "version zero. eighteen. zero."
 * and — because each fragment consumed part of a word budget — quietly pushed
 * the real sentence after it out of the script entirely.
 *
 * So a period is only a boundary when it is not sitting between two digits.
 * Both sides must be a digit: the trailing period in "0.18.0." follows a digit
 * but is not followed by one, and it does end the sentence.
 */
export function splitSentences(text: string): string[] {
	const matches = text.match(/(?:[^.!?]|(?<=\d)\.(?=\d))+[.!?]*/g);
	return (matches ?? [text]).map((sentence) => sentence.trim()).filter(Boolean);
}

/**
 * Trims narration to a word budget without cutting mid-sentence.
 *
 * Used as a backstop on model-written narration: the cap is enforced by
 * dropping whole sentences, because a sentence cut at word 55 sounds like the
 * audio failed rather than like an edit.
 */
export function capWords(text: string, maxWords: number): string {
	if (countWords(text) <= maxWords) { return text; }
	const sentences = splitSentences(text);
	const kept: string[] = [];
	let total = 0;
	for (const sentence of sentences) {
		const words = countWords(sentence);
		if (total > 0 && total + words > maxWords) { break; }
		kept.push(sentence);
		total += words;
	}
	return (kept.join(' ') || text).trim();
}

export function countWords(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Speaking-time estimate, used only when there is no audio to measure.
 *
 * The pipeline's rule is that the rendered WAV is the timing authority; this
 * exists for the `silence` voice engine and for the plan preview, where there
 * is no WAV yet and a plausible duration is better than none.
 */
export function estimateSeconds(text: string, wordsPerMinute = 150): number {
	return (countWords(text) / wordsPerMinute) * 60;
}
