/**
 * Director / Performer / Assessor split of a session's turns.
 *
 * GitHub's Agentic Engineering System describes three modes a person or agent
 * moves between: a **director** sets intent, scope and constraints, a
 * **performer** executes bounded work, and an **assessor** checks correctness
 * and safety. This module maps the per-turn task categories the extension
 * already computes (`taskClassification.turnCategories`) onto those modes.
 *
 * The mapping is a heuristic and lives in `participationModes.json` so it can
 * be tuned without touching code. Pure — safe for the CLI and tests.
 */
import type { ParticipationModeCounts } from './types';
import type { TaskCategory } from './taskClassification';
import mappingRaw from './participationModes.json';

export type ParticipationMode = keyof ParticipationModeCounts;
type CategoryMapping = ParticipationMode | 'contextual' | 'none';

const CATEGORY_MODES = (mappingRaw as { categories: Record<string, CategoryMapping> }).categories;

/** The mapping as shipped, for display next to the split. */
export function participationModeMapping(): Readonly<Record<string, CategoryMapping>> {
	return CATEGORY_MODES;
}

export function createEmptyModeCounts(): ParticipationModeCounts {
	return { director: 0, performer: 0, assessor: 0 };
}

export function addModeCounts(target: ParticipationModeCounts, source: ParticipationModeCounts): void {
	target.director += source.director;
	target.performer += source.performer;
	target.assessor += source.assessor;
}

/**
 * Count one session's turns per mode. A `contextual` category (Exploration)
 * counts as director before the session's first performer turn — reading to
 * scope the work — and as assessor after it — reading the change back.
 * Categories that map to `none` (Conversation) and unknown categories are not
 * counted.
 */
export function countParticipationModes(turnCategories: readonly (TaskCategory | string)[] | undefined): ParticipationModeCounts {
	const counts = createEmptyModeCounts();
	let performed = false;
	for (const category of turnCategories ?? []) {
		const mapped = CATEGORY_MODES[category];
		if (mapped === 'contextual') {
			counts[performed ? 'assessor' : 'director']++;
		} else if (mapped === 'director' || mapped === 'performer' || mapped === 'assessor') {
			counts[mapped]++;
			if (mapped === 'performer') { performed = true; }
		}
	}
	return counts;
}

/** Share of each mode in [0, 1]; all zero when no turn was counted. */
export function modeShares(counts: ParticipationModeCounts): ParticipationModeCounts {
	const total = counts.director + counts.performer + counts.assessor;
	if (total === 0) { return createEmptyModeCounts(); }
	return {
		director: counts.director / total,
		performer: counts.performer / total,
		assessor: counts.assessor / total,
	};
}
