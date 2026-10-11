/**
 * Is an agentic session's objective stated before the agent starts working?
 *
 * One of the anti-patterns GitHub's Agentic Engineering System names is
 * "delegating execution without clearly defining objectives". Locally the
 * closest observable proxy is the session's opening: a very short first
 * prompt, with no planning turn before the agent starts changing things.
 *
 * This is a heuristic signal, not a verdict — a short prompt can be perfectly
 * clear inside an existing context. It is only ever reported as a comparison
 * against the same user's longer-prompt sessions. Pure.
 */
import type { TaskCategory } from './taskClassification';

/** Opening prompts shorter than this (trimmed characters) count as short. Tunable. */
export const SHORT_PROMPT_CHARS = 80;

/** Sessions with at least this many user corrections count as "needed correcting". Tunable. */
export const CORRECTED_SESSION_MIN_USER_CORRECTIONS = 2;

/** Categories that mean the agent is changing things rather than reading or planning. */
const EXECUTION_CATEGORIES: ReadonlySet<string> = new Set<TaskCategory>([
	'Coding', 'Feature Dev', 'Refactoring', 'Debugging', 'Build/Deploy', 'Git Ops',
]);

export type SessionScoping = 'under-scoped' | 'scoped';

/**
 * Classify a session's opening. Returns undefined when there is no opening
 * prompt to judge. A slash command (`/fix …`) invokes a reusable prompt that
 * carries its own objective, so it is always `scoped`.
 */
export function classifySessionScoping(
	firstUserPrompt: string | undefined,
	turnCategories: readonly (TaskCategory | string)[] | undefined,
): SessionScoping | undefined {
	const prompt = firstUserPrompt?.trim();
	if (!prompt) { return undefined; }
	if (prompt.startsWith('/')) { return 'scoped'; }
	if (prompt.length >= SHORT_PROMPT_CHARS) { return 'scoped'; }
	return plannedBeforeExecution(turnCategories) ? 'scoped' : 'under-scoped';
}

/** True when a `Planning` turn appears before the first execution turn. */
export function plannedBeforeExecution(turnCategories: readonly (TaskCategory | string)[] | undefined): boolean {
	for (const category of turnCategories ?? []) {
		if (category === 'Planning') { return true; }
		if (EXECUTION_CATEGORIES.has(category)) { return false; }
	}
	return false;
}
