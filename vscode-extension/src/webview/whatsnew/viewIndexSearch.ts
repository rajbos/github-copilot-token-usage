/**
 * Fuzzy search over the View index. Pure (no DOM) so it can be unit tested.
 *
 * Every whitespace-separated word in the query must match one of an entry's
 * fields — its title, keywords, description, or the titles of the view and
 * tabs above it — so "tool slow" finds "Tool latency profile" through its
 * `slow` keyword. A word matches a field either as a plain substring or as a
 * fuzzy subsequence ("mcphlth" → "MCP server health"). Substrings score above
 * subsequences, word starts above mid-word hits, and titles above descriptions.
 */
import type { ViewIndexEntry } from '../../whatsNew/viewIndex';

export type ViewIndexSearchResult = {
	/** Entry ids that matched, best first. */
	readonly matchedIds: readonly string[];
	/** Score per matched id. */
	readonly scores: ReadonlyMap<string, number>;
};

/** Field weights: a hit in the title says more than one in the description. */
const WEIGHT = { title: 4, keywords: 3, path: 1.5, description: 1, condition: 0.5 } as const;

/**
 * A subsequence spread across more than this many times the word's length is
 * a coincidence, not a match ("ai" would otherwise match almost anything).
 */
const MAX_FUZZY_SPREAD = 3;

/** Shortest word that may match as a subsequence rather than a substring. */
const MIN_FUZZY_LENGTH = 3;

export function normalize(text: string): string {
	return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function tokenizeQuery(query: string): string[] {
	return normalize(query).split(/\s+/).filter((word) => word.length > 0);
}

/** 0 when `word` does not match `text`; otherwise higher is better, at most 1. */
export function scoreWord(word: string, text: string): number {
	const haystack = normalize(text);
	const index = haystack.indexOf(word);
	if (index >= 0) {
		const atWordStart = index === 0 || !/[a-z0-9]/.test(haystack[index - 1]);
		return atWordStart ? 1 : 0.8;
	}
	if (word.length < MIN_FUZZY_LENGTH) { return 0; }
	return scoreSubsequence(word, haystack);
}

/** Tightest in-order match of `word`'s characters in `haystack`, scored by how spread out it is. */
function scoreSubsequence(word: string, haystack: string): number {
	let best = 0;
	for (let start = haystack.indexOf(word[0]); start >= 0; start = haystack.indexOf(word[0], start + 1)) {
		let position = start;
		let matched = 1;
		for (; matched < word.length; matched++) {
			position = haystack.indexOf(word[matched], position + 1);
			if (position < 0) { break; }
		}
		if (matched < word.length) { break; } // later starts cannot complete either
		const span = position - start + 1;
		if (span > word.length * MAX_FUZZY_SPREAD) { continue; }
		const tightness = word.length / span; // 1 when contiguous
		best = Math.max(best, 0.2 + 0.4 * tightness);
	}
	return best;
}

function fieldsOf(entry: ViewIndexEntry): Array<{ text: string; weight: number }> {
	const { node } = entry;
	return [
		{ text: node.title, weight: WEIGHT.title },
		{ text: (node.keywords ?? []).join(' '), weight: WEIGHT.keywords },
		{ text: entry.path.slice(0, -1).join(' '), weight: WEIGHT.path },
		{ text: node.description, weight: WEIGHT.description },
		{ text: node.condition ?? '', weight: WEIGHT.condition },
	];
}

/** Score of one entry for the query's words, or 0 when any word fails to match. */
export function scoreEntry(entry: ViewIndexEntry, words: readonly string[]): number {
	const fields = fieldsOf(entry);
	let total = 0;
	for (const word of words) {
		let best = 0;
		for (const field of fields) {
			if (!field.text) { continue; }
			best = Math.max(best, scoreWord(word, field.text) * field.weight);
		}
		if (best === 0) { return 0; }
		total += best;
	}
	return total;
}

export function searchViewIndex(entries: readonly ViewIndexEntry[], query: string): ViewIndexSearchResult {
	const words = tokenizeQuery(query);
	const scores = new Map<string, number>();
	if (words.length === 0) { return { matchedIds: [], scores }; }
	for (const entry of entries) {
		const score = scoreEntry(entry, words);
		if (score > 0) { scores.set(entry.id, score); }
	}
	const matchedIds = [...scores.keys()].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
	return { matchedIds, scores };
}

/**
 * Character ranges in `text` to highlight for the query: every plain substring
 * hit of every word. Fuzzy hits are not highlighted — scattered single letters
 * read as noise, not as an explanation of why the line matched.
 */
export function highlightRanges(text: string, query: string): Array<[number, number]> {
	const haystack = normalize(text);
	// NFKD can change length (e.g. "é" → "e" + combining mark, then stripped);
	// only highlight when the normalized text still lines up with the original.
	if (haystack.length !== text.length) { return []; }
	const ranges: Array<[number, number]> = [];
	for (const word of tokenizeQuery(query)) {
		for (let index = haystack.indexOf(word); index >= 0; index = haystack.indexOf(word, index + word.length)) {
			ranges.push([index, index + word.length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) { last[1] = Math.max(last[1], range[1]); } else { merged.push([...range]); }
	}
	return merged;
}
