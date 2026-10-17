/**
 * Human-readable names for the views and tabs a feature can live on.
 *
 * The catalog names surfaces by id — `usage`, `tools`, `mistral-cloud` — which
 * is what the screenshot harness needs and exactly what narration must not
 * say. The harness registry already carries a display title for every view and
 * every tab, so that is where the spoken name comes from rather than from a
 * second hand-maintained table that would drift out of step.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT } from './util';

const REGISTRY = path.join(REPO_ROOT, '.github', 'skills', 'visual-view-diff', 'views.config.json');

interface Registry {
	views: {
		id: string;
		title?: string;
		states?: { id: string; title?: string }[];
	}[];
}

let cached: Registry | null = null;

function registry(): Registry {
	if (!cached) {
		cached = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as Registry;
	}
	return cached;
}

/** A tab's spoken name, split into its own name and the group it sits under. */
export interface TabName {
	/** "TTFT" from "Research › TTFT tab". */
	readonly leaf: string;
	/** "Research", when the tab is nested under a group. */
	readonly parent?: string;
}

/**
 * The display name of a view, e.g. `usage` -> "Usage Analysis".
 *
 * Falls back to a title-cased id so a view added to the catalog before it is
 * registered still produces sayable narration rather than the raw slug.
 */
export function viewName(viewId: string): string {
	const found = registry().views.find((view) => view.id === viewId);
	return found?.title?.trim() || titleCase(viewId);
}

/**
 * The display name of a tab, e.g. (`diagnostics`, `ttft`) -> TTFT under Research.
 *
 * The registry writes nested tabs as "Research › TTFT tab". Both the trailing
 * "tab" and the separator are stripped here, because the sentence being built
 * supplies its own wording for them — "on the TTFT tab, under Research" reads
 * like a person talking, and "on the Research › TTFT tab tab" does not.
 */
export function tabName(viewId: string, stateId: string): TabName {
	const view = registry().views.find((candidate) => candidate.id === viewId);
	const state = view?.states?.find((candidate) => candidate.id === stateId);
	const raw = state?.title?.trim() || titleCase(stateId);

	const withoutSuffix = raw.replace(/\s+tab$/i, '').trim();
	const parts = withoutSuffix.split(/\s*[›>]\s*/).filter(Boolean);

	if (parts.length > 1) {
		const leaf = parts[parts.length - 1] ?? withoutSuffix;
		const parent = parts.slice(0, -1).join(', ');
		return { leaf, parent };
	}
	return { leaf: withoutSuffix || titleCase(stateId) };
}

function titleCase(id: string): string {
	return id
		.split(/[-_]/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}
