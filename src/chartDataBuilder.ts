import type { DailyTokenStats, ChartDataPayload, ModelUsage, LanguageUsage } from './types';
import { addModelUsage, COPILOT_EDITOR_NAMES } from './statsHelpers';
import { mergeDailyModelEfficiency } from './modelEfficiency';
import { getModelDisplayName, getCustomProviderGroup, getModelLookupCandidates } from './webview/shared/modelUtils';
import { TASK_CATEGORIES, type TaskCategory } from './taskClassification';

// Re-exported for existing consumers; the set lives in statsHelpers so the
// period accumulator can use it without a circular import.
export { COPILOT_EDITOR_NAMES } from './statsHelpers';

/** Returns the pricing source to use for cost estimation for a given editor. */
export function getPricingSourceForEditor(editor: string): 'provider' | 'copilot' {
	return COPILOT_EDITOR_NAMES.has(editor) ? 'copilot' : 'provider';
}

/** Prefix-to-billing-provider lookup table, checked in order. */
const MODEL_PROVIDER_PREFIXES: Array<[string, string]> = [
	['anthropic', 'Anthropic'],
	['claude', 'Anthropic'],
	['codestral', 'Mistral AI'],
	['devstral', 'Mistral AI'],
	['gemini', 'Google'],
	['glm', 'Z.ai'],
	['goldeneye', 'xAI'],
	['google', 'Google'],
	['gpt', 'OpenAI'],
	['grok', 'xAI'],
	['magistral', 'Mistral AI'],
	['mai-', 'Microsoft'],
	['ministral', 'Mistral AI'],
	['mistral', 'Mistral AI'],
	['o1', 'OpenAI'],
	['o3', 'OpenAI'],
	['o4', 'OpenAI'],
	['pixtral', 'Mistral AI'],
	['qwen', 'Alibaba'],
	['raptor', 'xAI'],
];

/**
 * Maps a model ID to its billing provider name.
 * Used for non-Copilot surfaces where the bill goes directly to the model vendor.
 * Models from a user-configured custom endpoint get their own group named after the
 * provider name the user typed (e.g. "Mistral (Custom)").
 */
export function getModelBillingProvider(modelId: string): string {
	const customGroup = getCustomProviderGroup(modelId);
	if (customGroup) { return customGroup; }
	// HydraFusion is Copilot's own router, not any vendor's model: the real models
	// behind it vary per turn, so the only honest provider is the one running it.
	// The bare `auto` id is deliberately *not* mapped here — Kiro CLI records every
	// session under `auto` too, and this helper has no editor context to tell them apart.
	if (modelId === 'hydrafusion') { return 'GitHub Copilot'; }
	const match = getModelLookupCandidates(modelId)
		.flatMap(candidate => MODEL_PROVIDER_PREFIXES.filter(([prefix]) => candidate.toLowerCase().startsWith(prefix)))
		.at(0);
	return match ? match[1] : 'Other';
}

/**
 * Returns the billing group for a (editor, modelId) pair:
 * - Custom endpoints (BYOK) → the user's own provider group ("Mistral (Custom)"), on every
 *   surface: these calls go straight to the user's endpoint with their own key, so they are
 *   billed by that provider and not through Copilot's AI-Credit system
 * - Other models on Copilot surfaces → always "GitHub Copilot" regardless of underlying model
 * - All other surfaces → the model's provider (Anthropic, Google, Mistral AI, OpenAI, etc.)
 */
export function getBillingGroup(editor: string, modelId: string): string {
	const customGroup = getCustomProviderGroup(modelId);
	if (customGroup) { return customGroup; }
	if (COPILOT_EDITOR_NAMES.has(editor)) { return 'GitHub Copilot'; }
	return getModelBillingProvider(modelId);
}

/** Chart.js-compatible colour palette for dataset series. */
export const MODEL_COLORS = [
	{ bg: "rgba(54, 162, 235, 0.6)", border: "rgba(54, 162, 235, 1)" },
	{ bg: "rgba(255, 99, 132, 0.6)", border: "rgba(255, 99, 132, 1)" },
	{ bg: "rgba(75, 192, 192, 0.6)", border: "rgba(75, 192, 192, 1)" },
	{ bg: "rgba(153, 102, 255, 0.6)", border: "rgba(153, 102, 255, 1)" },
	{ bg: "rgba(255, 159, 64, 0.6)", border: "rgba(255, 159, 64, 1)" },
	{ bg: "rgba(255, 205, 86, 0.6)", border: "rgba(255, 205, 86, 1)" },
	{ bg: "rgba(201, 203, 207, 0.6)", border: "rgba(201, 203, 207, 1)" },
	{ bg: "rgba(100, 181, 246, 0.6)", border: "rgba(100, 181, 246, 1)" },
];

/** Returns the colour entry for the given series index, wrapping around the palette. */
export function getModelColor(index: number): { bg: string; border: string } {
	return MODEL_COLORS[index % MODEL_COLORS.length];
}

/** Dependencies injected into buildChartData to decouple it from extension state. */
export interface ChartDataBuilderDeps {
	/** Format a raw repository URL into a short display name (e.g. "owner/repo"). */
	getRepoDisplayName: (url: string) => string;
	/** Estimate USD cost for the given model usage. */
	calculateEstimatedCost: (modelUsage: ModelUsage, pricingSource: 'provider' | 'copilot') => number;
	/** Whether a backend (Azure Storage or team server) is currently configured. */
	backendConfigured: boolean;
	/** Whether compact number formatting is enabled in extension settings. */
	compactNumbers: boolean;
	/** Current date/time. Defaults to `new Date()` when omitted; injectable for testing. */
	now?: Date;
}

type BucketEntry = { label: string; key: string; stats: DailyTokenStats };

function fmtKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyEntry(date: string): DailyTokenStats {
	return { date, tokens: 0, sessions: 0, interactions: 0, modelUsage: {}, editorUsage: {}, repositoryUsage: {}, taskCategoryUsage: {} };
}

function mergeUsageGroup(
	target: Record<string, { tokens: number; sessions: number; linesAdded?: number; linesRemoved?: number }>,
	src: Record<string, { tokens: number; sessions: number; linesAdded?: number; linesRemoved?: number }>
): void {
	for (const [k, u] of Object.entries(src)) {
		if (!target[k]) { target[k] = { tokens: 0, sessions: 0 }; }
		target[k].tokens += u.tokens;
		target[k].sessions += u.sessions;
		if (u.linesAdded !== undefined) { target[k].linesAdded = (target[k].linesAdded ?? 0) + u.linesAdded; }
		if (u.linesRemoved !== undefined) { target[k].linesRemoved = (target[k].linesRemoved ?? 0) + u.linesRemoved; }
	}
}

function mergeLanguageUsage(target: DailyTokenStats, src: DailyTokenStats): void {
	if (!src.languageUsage) { return; }
	if (!target.languageUsage) { target.languageUsage = {}; }
	for (const [ext, usage] of Object.entries(src.languageUsage)) {
		if (!target.languageUsage[ext]) { target.languageUsage[ext] = { linesAdded: 0, linesRemoved: 0 }; }
		target.languageUsage[ext].linesAdded += usage.linesAdded;
		target.languageUsage[ext].linesRemoved += usage.linesRemoved;
	}
}

function mergeEditorModelUsage(target: DailyTokenStats, src: DailyTokenStats): void {
	if (!src.editorModelUsage) { return; }
	if (!target.editorModelUsage) { target.editorModelUsage = {}; }
	for (const [editor, modelUsage] of Object.entries(src.editorModelUsage)) {
		if (!target.editorModelUsage[editor]) { target.editorModelUsage[editor] = {}; }
		addModelUsage(target.editorModelUsage[editor], modelUsage);
	}
}

function mergeTaskCategoryUsage(target: DailyTokenStats, src: DailyTokenStats): void {
	if (src.taskCategoryTokens) {
		target.taskCategoryTokens = target.taskCategoryTokens ?? {};
		for (const [category, value] of Object.entries(src.taskCategoryTokens)) {
			target.taskCategoryTokens[category as TaskCategory] = (target.taskCategoryTokens[category as TaskCategory] || 0) + value;
		}
	}
	if (src.taskCategorySessions) {
		target.taskCategorySessions = target.taskCategorySessions ?? {};
		for (const [category, value] of Object.entries(src.taskCategorySessions)) {
			target.taskCategorySessions[category as TaskCategory] = (target.taskCategorySessions[category as TaskCategory] || 0) + value;
		}
	}
	if (!src.taskCategoryModelUsage) { return; }
	target.taskCategoryModelUsage = target.taskCategoryModelUsage ?? {};
	for (const [category, usage] of Object.entries(src.taskCategoryModelUsage)) {
		const key = category as TaskCategory;
		target.taskCategoryModelUsage[key] = target.taskCategoryModelUsage[key] ?? {};
		addModelUsage(target.taskCategoryModelUsage[key]!, usage);
	}
}

function mergeInto(target: DailyTokenStats, src: DailyTokenStats): void {
	target.tokens += src.tokens;
	target.sessions += src.sessions;
	target.interactions += src.interactions;
	addModelUsage(target.modelUsage, src.modelUsage);
	mergeUsageGroup(target.editorUsage, src.editorUsage);
	mergeUsageGroup(target.repositoryUsage, src.repositoryUsage);
	if (!target.taskCategoryUsage) { target.taskCategoryUsage = {}; }
	mergeUsageGroup(target.taskCategoryUsage, src.taskCategoryUsage ?? {});
	if (src.linesAdded !== undefined) { target.linesAdded = (target.linesAdded ?? 0) + src.linesAdded; }
	if (src.linesRemoved !== undefined) { target.linesRemoved = (target.linesRemoved ?? 0) + src.linesRemoved; }
	mergeLanguageUsage(target, src);
	mergeEditorModelUsage(target, src);
	mergeTaskCategoryUsage(target, src);
	if (src.modelEfficiency) {
		if (!target.modelEfficiency) { target.modelEfficiency = {}; }
		mergeDailyModelEfficiency(target.modelEfficiency, src.modelEfficiency);
	}
}

function getMondayOfWeek(d: Date): Date {
	const copy = new Date(d); copy.setHours(0, 0, 0, 0);
	const day = copy.getDay();
	copy.setDate(copy.getDate() - (day === 0 ? 6 : day - 1));
	return copy;
}

function fmtWeekLabel(monday: Date): string {
	const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
	if (monday.getMonth() === sunday.getMonth()) {
		return `${monday.toLocaleDateString("en-US", { month: "short" })} ${monday.getDate()}–${sunday.getDate()}`;
	}
	return `${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${sunday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function buildDailyBuckets(fullDailyStats: DailyTokenStats[], now: Date): BucketEntry[] {
	const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
	let startDate = new Date(thirtyDaysAgo);
	for (const day of fullDailyStats) {
		const d = new Date(day.date + 'T00:00:00');
		if (d < startDate) { startDate = d; }
	}
	const startStr = fmtKey(startDate);
	const todayStr = fmtKey(now);
	const bucketMap = new Map<string, BucketEntry>();
	for (let cursor = new Date(startDate); cursor <= now; cursor.setDate(cursor.getDate() + 1)) {
		const key = fmtKey(new Date(cursor));
		bucketMap.set(key, { key, label: key, stats: emptyEntry(key) });
	}
	for (const day of fullDailyStats) {
		if (day.date >= startStr && day.date <= todayStr) {
			const bucket = bucketMap.get(day.date);
			if (bucket) { mergeInto(bucket.stats, day); }
		}
	}
	return Array.from(bucketMap.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function buildWeeklyBuckets(fullDailyStats: DailyTokenStats[], now: Date): BucketEntry[] {
	const thisMonday = getMondayOfWeek(now);
	let earliestMonday = new Date(thisMonday);
	for (let w = 5; w >= 0; w--) {
		const monday = new Date(thisMonday); monday.setDate(thisMonday.getDate() - w * 7);
		if (monday < earliestMonday) { earliestMonday = monday; }
	}
	for (const day of fullDailyStats) {
		const monday = getMondayOfWeek(new Date(day.date + "T00:00:00"));
		if (monday < earliestMonday) { earliestMonday = monday; }
	}
	const bucketMap = new Map<string, BucketEntry>();
	for (let cursor = new Date(earliestMonday); cursor <= thisMonday; cursor.setDate(cursor.getDate() + 7)) {
		const monday = new Date(cursor);
		const key = fmtKey(monday);
		bucketMap.set(key, { key, label: fmtWeekLabel(monday), stats: emptyEntry(key) });
	}
	for (const day of fullDailyStats) {
		const monday = getMondayOfWeek(new Date(day.date + "T00:00:00"));
		const bucket = bucketMap.get(fmtKey(monday));
		if (bucket) { mergeInto(bucket.stats, day); }
	}
	return Array.from(bucketMap.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function buildMonthlyBuckets(fullDailyStats: DailyTokenStats[], now: Date): BucketEntry[] {
	const bucketMap = new Map<string, BucketEntry>();
	let earliestYear = now.getFullYear();
	let earliestMonth = now.getMonth() - 11;
	while (earliestMonth < 0) { earliestYear--; earliestMonth += 12; }
	for (const day of fullDailyStats) {
		const [year, month] = day.date.split('-').map(Number);
		if (year < earliestYear || (year === earliestYear && month - 1 < earliestMonth)) {
			earliestYear = year;
			earliestMonth = month - 1;
		}
	}
	const monthsCount = (now.getFullYear() - earliestYear) * 12 + (now.getMonth() - earliestMonth);
	for (let i = 0; i <= monthsCount; i++) {
		const monthDate = new Date(earliestYear, earliestMonth + i, 1);
		const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
		const label = monthDate.toLocaleDateString("en-US", { month: "short", year: "numeric" });
		bucketMap.set(key, { key, label, stats: emptyEntry(key) });
	}
	for (const day of fullDailyStats) {
		const monthKey = day.date.slice(0, 7);
		const bucket = bucketMap.get(monthKey);
		if (bucket) { mergeInto(bucket.stats, day); }
	}
	return Array.from(bucketMap.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function buildModelDatasets(entries: DailyTokenStats[], deps: ChartDataBuilderDeps) {
	const allModels = new Set<string>();
	entries.forEach(e => Object.keys(e.modelUsage).forEach(m => allModels.add(m)));
	const modelTotals = new Map<string, number>();
	for (const model of allModels) {
		const total = entries.reduce((sum, e) => { const u = e.modelUsage[model]; return sum + (u ? u.inputTokens + u.outputTokens : 0); }, 0);
		modelTotals.set(model, total);
	}
	const sortedModels = Array.from(allModels).sort((a, b) => (modelTotals.get(b) || 0) - (modelTotals.get(a) || 0));
	const topModels = sortedModels.slice(0, 5);
	const otherModels = sortedModels.slice(5);
	const datasets = topModels.map((model, idx) => {
		const color = getModelColor(idx);
		return { label: getModelDisplayName(model), data: entries.map(e => { const u = e.modelUsage[model]; return u ? u.inputTokens + u.outputTokens : 0; }), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	if (otherModels.length > 0) {
		datasets.push({ label: 'Other models', data: entries.map(e => otherModels.reduce((sum, m) => { const u = e.modelUsage[m]; return sum + (u ? u.inputTokens + u.outputTokens : 0); }, 0)), backgroundColor: 'rgba(150, 150, 150, 0.5)', borderColor: 'rgba(150, 150, 150, 0.8)', borderWidth: 1 });
	}
	return datasets;
}

/** Builds session-count datasets split by model. */
function buildModelSessionsDatasets(entries: DailyTokenStats[]) {
	const allModels = new Set<string>();
	entries.forEach(e => Object.keys(e.modelUsage).forEach(m => allModels.add(m)));
	const modelSessionTotals = new Map<string, number>();
	for (const model of allModels) {
		const total = entries.reduce((sum, e) => sum + (e.modelUsage[model]?.sessions ?? 0), 0);
		modelSessionTotals.set(model, total);
	}
	const sortedModels = Array.from(allModels).sort((a, b) => (modelSessionTotals.get(b) || 0) - (modelSessionTotals.get(a) || 0));
	const topModels = sortedModels.slice(0, 5);
	const otherModels = sortedModels.slice(5);
	const datasets = topModels.map((model, idx) => {
		const color = getModelColor(idx);
		return { label: getModelDisplayName(model), data: entries.map(e => e.modelUsage[model]?.sessions ?? 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	if (otherModels.length > 0) {
		datasets.push({ label: 'Other models', data: entries.map(e => otherModels.reduce((sum, m) => sum + (e.modelUsage[m]?.sessions ?? 0), 0)), backgroundColor: 'rgba(150, 150, 150, 0.5)', borderColor: 'rgba(150, 150, 150, 0.8)', borderWidth: 1 });
	}
	return datasets;
}

/** Builds session-count datasets split by editor. */
function buildEditorSessionsDatasets(entries: DailyTokenStats[]) {
	const allEditors = new Set<string>();
	entries.forEach(e => Object.keys(e.editorUsage).forEach(ed => allEditors.add(ed)));
	const editorSessionTotals = new Map<string, number>();
	for (const editor of allEditors) {
		const total = entries.reduce((sum, e) => sum + (e.editorUsage[editor]?.sessions ?? 0), 0);
		editorSessionTotals.set(editor, total);
	}
	const sortedEditors = Array.from(allEditors).sort((a, b) => (editorSessionTotals.get(b) || 0) - (editorSessionTotals.get(a) || 0));
	return sortedEditors.map((editor, idx) => {
		const color = getModelColor(idx);
		return { label: editor, data: entries.map(e => e.editorUsage[editor]?.sessions ?? 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
}

/** Aggregates per-editor-model session counts up to billing provider groups. */
function aggregateBillingGroupSessions(entry: DailyTokenStats): Record<string, number> {
	const result: Record<string, number> = {};
	const editorModelUsage = entry.editorModelUsage;
	if (!editorModelUsage) { return result; }
	for (const [editor, modelUsage] of Object.entries(editorModelUsage)) {
		for (const [modelId, usage] of Object.entries(modelUsage)) {
			const group = getBillingGroup(editor, modelId);
			result[group] = (result[group] ?? 0) + usage.sessions;
		}
	}
	return result;
}

/** Builds session-count datasets split by billing provider. */
function buildProviderSessionsDatasets(entries: DailyTokenStats[]) {
	const allGroups = new Set<string>();
	entries.forEach(e => Object.keys(aggregateBillingGroupSessions(e)).forEach(g => allGroups.add(g)));
	const groupTotals = new Map<string, number>();
	for (const group of allGroups) {
		const total = entries.reduce((sum, e) => sum + (aggregateBillingGroupSessions(e)[group] ?? 0), 0);
		groupTotals.set(group, total);
	}
	const sortedGroups = Array.from(allGroups).sort((a, b) => (groupTotals.get(b) || 0) - (groupTotals.get(a) || 0));
	return sortedGroups.map((group, idx) => {
		const color = getModelColor(idx);
		return { label: group, data: entries.map(e => aggregateBillingGroupSessions(e)[group] ?? 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
}

/**
 * Builds cost datasets split by editor/hosting surface.
 * Each dataset holds per-bucket estimated costs for one editor type, using the
 * appropriate pricing source (Copilot AI-Credit pricing for GitHub Copilot surfaces;
 * direct provider pricing for all others).
 */
function buildEditorCostDatasets(entries: DailyTokenStats[], deps: ChartDataBuilderDeps) {
	const allEditors = new Set<string>();
	entries.forEach(e => { if (e.editorModelUsage) { Object.keys(e.editorModelUsage).forEach(ed => allEditors.add(ed)); } });
	const editorTotals = new Map<string, number>();
	for (const editor of allEditors) {
		const total = entries.reduce((sum, e) => sum + deps.calculateEstimatedCost(e.editorModelUsage?.[editor] ?? {}, getPricingSourceForEditor(editor)), 0);
		editorTotals.set(editor, total);
	}
	const sortedEditors = Array.from(allEditors).sort((a, b) => (editorTotals.get(b) || 0) - (editorTotals.get(a) || 0));
	return sortedEditors.map((editor, idx) => {
		const color = getModelColor(idx);
		return {
			label: editor,
			data: entries.map(e => deps.calculateEstimatedCost(e.editorModelUsage?.[editor] ?? {}, getPricingSourceForEditor(editor))),
			backgroundColor: color.bg,
			borderColor: color.border,
			borderWidth: 1,
		};
	});
}

function buildTaskCategoryTokenDatasets(entries: DailyTokenStats[]) {
	return TASK_CATEGORIES.map((category, idx) => {
		const color = getModelColor(idx);
		return {
			label: category,
			data: entries.map(e => e.taskCategoryTokens?.[category] || 0),
			backgroundColor: color.bg,
			borderColor: color.border,
			borderWidth: 1,
		};
	}).filter(ds => ds.data.some(v => v > 0));
}

function buildTaskCategorySessionDatasets(entries: DailyTokenStats[]) {
	return TASK_CATEGORIES.map((category, idx) => {
		const color = getModelColor(idx);
		return {
			label: category,
			data: entries.map(e => e.taskCategorySessions?.[category] || 0),
			backgroundColor: color.bg,
			borderColor: color.border,
			borderWidth: 1,
		};
	}).filter(ds => ds.data.some(v => v > 0));
}

function buildTaskCategoryCostDatasets(entries: DailyTokenStats[], deps: ChartDataBuilderDeps) {
	return TASK_CATEGORIES.map((category, idx) => {
		const color = getModelColor(idx);
		return {
			label: category,
			data: entries.map(e => deps.calculateEstimatedCost(e.taskCategoryModelUsage?.[category] ?? {}, 'copilot')),
			backgroundColor: color.bg,
			borderColor: color.border,
			borderWidth: 1,
		};
	}).filter(ds => ds.data.some(v => v > 0));
}

/**
 * Aggregates model usage per billing group from a day's editorModelUsage.
 *
 * For Copilot surfaces (VS Code, JetBrains, Visual Studio, …) all models are
 * lumped into "GitHub Copilot" regardless of the underlying model.
 * For every other surface the billing group is the model's vendor
 * (Anthropic, Google, Mistral AI, OpenAI, xAI, …).
 */
function aggregateBillingGroupModelUsage(entry: DailyTokenStats): Record<string, ModelUsage> {
	const result: Record<string, ModelUsage> = {};
	const editorModelUsage = entry.editorModelUsage;
	if (!editorModelUsage) { return result; }
	for (const [editor, modelUsage] of Object.entries(editorModelUsage)) {
		for (const [modelId, usage] of Object.entries(modelUsage)) {
			const group = getBillingGroup(editor, modelId);
			if (!result[group]) { result[group] = {}; }
			addModelUsage(result[group], { [modelId]: usage });
		}
	}
	return result;
}

/**
 * Returns the pricing source for a billing group.
 * "GitHub Copilot" bills through GitHub's AI-Credit system; all others are direct provider rates.
 */
export function getPricingSourceForBillingGroup(group: string): 'provider' | 'copilot' {
	return group === 'GitHub Copilot' ? 'copilot' : 'provider';
}

/**
 * Computes the estimated cost of one model's usage within a single day/bucket entry,
 * applying the correct pricing source per editor the model was used from.
 * Falls back to Copilot pricing when no per-editor breakdown is available.
 */
function computeModelCostForEntry(entry: DailyTokenStats, model: string, deps: ChartDataBuilderDeps): number {
	const editorModelUsage = entry.editorModelUsage;
	if (!editorModelUsage) {
		const usage = entry.modelUsage[model];
		return usage ? deps.calculateEstimatedCost({ [model]: usage }, 'copilot') : 0;
	}
	let total = 0;
	for (const [editor, modelUsage] of Object.entries(editorModelUsage)) {
		const usage = modelUsage[model];
		if (usage) { total += deps.calculateEstimatedCost({ [model]: usage }, getPricingSourceForEditor(editor)); }
	}
	return total;
}

/**
 * Builds cost datasets split by model — one dataset per top model (by total cost),
 * with a combined "Other models" dataset for the remainder.
 * Each model's usage is priced using the correct pricing source per editor it was used from
 * (e.g. the same Claude model costs differently via GitHub Copilot vs. a direct API surface).
 */
function buildModelCostDatasets(entries: DailyTokenStats[], deps: ChartDataBuilderDeps) {
	const allModels = new Set<string>();
	entries.forEach(e => Object.keys(e.modelUsage).forEach(m => allModels.add(m)));
	const modelCostTotals = new Map<string, number>();
	for (const model of allModels) {
		const total = entries.reduce((sum, e) => sum + computeModelCostForEntry(e, model, deps), 0);
		modelCostTotals.set(model, total);
	}
	const sortedModels = Array.from(allModels).sort((a, b) => (modelCostTotals.get(b) || 0) - (modelCostTotals.get(a) || 0));
	const topModels = sortedModels.slice(0, 5);
	const otherModels = sortedModels.slice(5);
	const datasets = topModels.map((model, idx) => {
		const color = getModelColor(idx);
		return { label: getModelDisplayName(model), data: entries.map(e => computeModelCostForEntry(e, model, deps)), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	if (otherModels.length > 0) {
		datasets.push({ label: 'Other models', data: entries.map(e => otherModels.reduce((sum, m) => sum + computeModelCostForEntry(e, m, deps), 0)), backgroundColor: 'rgba(150, 150, 150, 0.5)', borderColor: 'rgba(150, 150, 150, 0.8)', borderWidth: 1 });
	}
	return datasets;
}

/** Aggregates per-editor-model token counts up to billing provider groups. */
function aggregateBillingGroupTokens(entry: DailyTokenStats): Record<string, number> {
	const result: Record<string, number> = {};
	const editorModelUsage = entry.editorModelUsage;
	if (!editorModelUsage) { return result; }
	for (const [editor, modelUsage] of Object.entries(editorModelUsage)) {
		for (const [modelId, usage] of Object.entries(modelUsage)) {
			const group = getBillingGroup(editor, modelId);
			result[group] = (result[group] ?? 0) + usage.inputTokens + usage.outputTokens;
		}
	}
	return result;
}

/** Builds token datasets split by billing/hosting provider. */
function buildProviderTokensDatasets(entries: DailyTokenStats[]) {
	const allGroups = new Set<string>();
	entries.forEach(e => Object.keys(aggregateBillingGroupTokens(e)).forEach(g => allGroups.add(g)));
	const groupTotals = new Map<string, number>();
	for (const group of allGroups) {
		const total = entries.reduce((sum, e) => sum + (aggregateBillingGroupTokens(e)[group] ?? 0), 0);
		groupTotals.set(group, total);
	}
	const sortedGroups = Array.from(allGroups).sort((a, b) => (groupTotals.get(b) || 0) - (groupTotals.get(a) || 0));
	return sortedGroups.map((group, idx) => {
		const color = getModelColor(idx);
		return { label: group, data: entries.map(e => aggregateBillingGroupTokens(e)[group] ?? 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
}

/**
 * Builds cost datasets split by billing/hosting provider.
 * One dataset per billing group (e.g. "GitHub Copilot", "Anthropic", "Google", …),
 * using the correct pricing source for each group.
 */
function buildBillingGroupCostDatasets(entries: DailyTokenStats[], deps: ChartDataBuilderDeps) {
	const allGroups = new Set<string>();
	entries.forEach(e => { Object.keys(aggregateBillingGroupModelUsage(e)).forEach(g => allGroups.add(g)); });
	const groupTotals = new Map<string, number>();
	for (const group of allGroups) {
		const total = entries.reduce((sum, e) => {
			const grouped = aggregateBillingGroupModelUsage(e);
			return sum + deps.calculateEstimatedCost(grouped[group] ?? {}, getPricingSourceForBillingGroup(group));
		}, 0);
		groupTotals.set(group, total);
	}

	const sortedGroups = Array.from(allGroups).sort((a, b) => (groupTotals.get(b) || 0) - (groupTotals.get(a) || 0));
	return sortedGroups.map((group, idx) => {
		const color = getModelColor(idx);
		return {
			label: group,
			data: entries.map(e => {
				const grouped = aggregateBillingGroupModelUsage(e);
				return deps.calculateEstimatedCost(grouped[group] ?? {}, getPricingSourceForBillingGroup(group));
			}),
			backgroundColor: color.bg,
			borderColor: color.border,
			borderWidth: 1,
		};
	});
}

function buildPeriodData(buckets: BucketEntry[], deps: ChartDataBuilderDeps) {
	const entries = buckets.map(b => b.stats);
	const labels = buckets.map(b => b.label);
	const periodKeys = buckets.map(b => b.key);
	const tokensData = entries.map(e => e.tokens);
	const sessionsData = entries.map(e => e.sessions);
	const modelDatasets = buildModelDatasets(entries, deps);
	const allEditors = new Set<string>();
	entries.forEach(e => Object.keys(e.editorUsage).forEach(ed => allEditors.add(ed)));
	const editorDatasets = Array.from(allEditors).map((editor, idx) => {
		const color = getModelColor(idx);
		return { label: editor, data: entries.map(e => e.editorUsage[editor]?.tokens || 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	const allRepos = new Set<string>();
	entries.forEach(e => Object.keys(e.repositoryUsage).filter(r => r !== 'Unknown').forEach(r => allRepos.add(r)));
	const repositoryDatasets = Array.from(allRepos).map((repo, idx) => {
		const color = getModelColor(idx);
		return { label: deps.getRepoDisplayName(repo), fullRepo: repo, data: entries.map(e => e.repositoryUsage[repo]?.tokens || 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	const totalTokens = tokensData.reduce((a, b) => a + b, 0);
	const totalSessions = sessionsData.reduce((a, b) => a + b, 0);
	const periodCount = buckets.length;
	const costData = entries.map(e => deps.calculateEstimatedCost(e.modelUsage, 'copilot'));
	const totalCost = costData.reduce((a, b) => a + b, 0);
	const locData = entries.map(e => (e.linesAdded ?? 0) + (e.linesRemoved ?? 0));
	const linesAddedData = entries.map(e => e.linesAdded ?? 0);
	const linesRemovedData = entries.map(e => e.linesRemoved ?? 0);
	const totalLinesAdded = entries.reduce((s, e) => s + (e.linesAdded ?? 0), 0);
	const totalLinesRemoved = entries.reduce((s, e) => s + (e.linesRemoved ?? 0), 0);
	const totalLoc = totalLinesAdded + totalLinesRemoved;
	const avgLocPerPeriod = entries.length > 0 ? totalLoc / entries.length : 0;
	const allLanguages = new Set<string>();
	entries.forEach(e => { if (e.languageUsage) { Object.keys(e.languageUsage).forEach(l => allLanguages.add(l)); } });
	const languageDatasets = Array.from(allLanguages).map((lang, idx) => {
		const color = getModelColor(idx);
		return { label: lang, data: entries.map(e => (e.languageUsage?.[lang]?.linesAdded ?? 0) + (e.languageUsage?.[lang]?.linesRemoved ?? 0)), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	const locEditorDatasets = Array.from(allEditors).map((editor, idx) => {
		const color = getModelColor(idx);
		return { label: editor, data: entries.map(e => (e.editorUsage[editor]?.linesAdded ?? 0) + (e.editorUsage[editor]?.linesRemoved ?? 0)), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	const locRepositoryDatasets = Array.from(allRepos).map((repo, idx) => {
		const color = getModelColor(idx);
		return { label: deps.getRepoDisplayName(repo), fullRepo: repo, data: entries.map(e => (e.repositoryUsage[repo]?.linesAdded ?? 0) + (e.repositoryUsage[repo]?.linesRemoved ?? 0)), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	const editorCostDatasets = buildEditorCostDatasets(entries, deps);
	const billingGroupCostDatasets = buildBillingGroupCostDatasets(entries, deps);
	const modelCostDatasets = buildModelCostDatasets(entries, deps);
	const modelSessionsDatasets = buildModelSessionsDatasets(entries);
	const editorSessionsDatasets = buildEditorSessionsDatasets(entries);
	const providerSessionsDatasets = buildProviderSessionsDatasets(entries);
	const providerTokensDatasets = buildProviderTokensDatasets(entries);
	const taskCategoryTokenDatasets = buildTaskCategoryTokenDatasets(entries);
	const taskCategorySessionDatasets = buildTaskCategorySessionDatasets(entries);
	const taskCategoryCostDatasets = buildTaskCategoryCostDatasets(entries, deps);
	const allTaskCategories = new Set<string>();
	entries.forEach(e => Object.keys(e.taskCategoryUsage ?? {}).forEach(tc => allTaskCategories.add(tc)));
	const taskCategoryDatasets = Array.from(allTaskCategories).map((category, idx) => {
		const color = getModelColor(idx);
		return { label: category, data: entries.map(e => e.taskCategoryUsage?.[category]?.tokens || 0), backgroundColor: color.bg, borderColor: color.border, borderWidth: 1 };
	});
	return {
		labels,
		periodKeys,
		tokensData,
		sessionsData,
		modelDatasets,
		editorDatasets,
		repositoryDatasets,
		periodCount,
		totalTokens,
		totalSessions,
		avgPerPeriod: periodCount > 0 ? Math.round(totalTokens / periodCount) : 0,
		costData,
		totalCost,
		avgCostPerPeriod: periodCount > 0 ? totalCost / periodCount : 0,
		locData,
		linesAddedData,
		linesRemovedData,
		languageDatasets,
		locEditorDatasets,
		locRepositoryDatasets,
		totalLinesAdded,
		totalLinesRemoved,
		avgLocPerPeriod,
		editorCostDatasets,
		billingGroupCostDatasets,
		modelCostDatasets,
		modelSessionsDatasets,
		editorSessionsDatasets,
		providerSessionsDatasets,
		providerTokensDatasets,
		taskCategoryDatasets,
		taskCategoryTokenDatasets,
		taskCategorySessionDatasets,
		taskCategoryCostDatasets,
	};
};

function computeSummaryTotals(dailyBuckets: BucketEntry[], deps: ChartDataBuilderDeps) {
	const editorTotalsMap: Record<string, number> = {};
	dailyBuckets.forEach(b => {
		Object.entries(b.stats.editorUsage).forEach(([editor, usage]) => {
			editorTotalsMap[editor] = (editorTotalsMap[editor] || 0) + usage.tokens;
		});
	});
	const repositoryTotalsMap: Record<string, number> = {};
	dailyBuckets.forEach(b => {
		Object.entries(b.stats.repositoryUsage).filter(([repo]) => repo !== 'Unknown').forEach(([repo, usage]) => {
			const displayName = deps.getRepoDisplayName(repo);
			repositoryTotalsMap[displayName] = (repositoryTotalsMap[displayName] || 0) + usage.tokens;
		});
	});
	return { editorTotalsMap, repositoryTotalsMap };
}

/**
 * Aggregate daily token stats into the chart payload used by the chart webview.
 * Produces daily, weekly, and monthly period data covering at least the recent default
 * window (30 days / 6 weeks / 12 months) and extending back to the earliest available
 * session so the "All time" time-window option can display the full history.
 */
export function buildChartData(fullDailyStats: DailyTokenStats[], deps: ChartDataBuilderDeps): ChartDataPayload {
	const now = deps.now ?? new Date();
	const dailyBuckets = buildDailyBuckets(fullDailyStats, now);
	const weeklyBuckets = buildWeeklyBuckets(fullDailyStats, now);
	const monthlyBuckets = buildMonthlyBuckets(fullDailyStats, now);
	const dailyPeriod = buildPeriodData(dailyBuckets, deps);
	const weeklyPeriod = buildPeriodData(weeklyBuckets, deps);
	const monthlyPeriod = buildPeriodData(monthlyBuckets, deps);
	const { editorTotalsMap, repositoryTotalsMap } = computeSummaryTotals(dailyBuckets, deps);
	const hasLocData = dailyBuckets.some(b => (b.stats.linesAdded ?? 0) + (b.stats.linesRemoved ?? 0) > 0)
		|| fullDailyStats.some(d => (d.linesAdded ?? 0) + (d.linesRemoved ?? 0) > 0);
	return {
		labels: dailyPeriod.labels,
		tokensData: dailyPeriod.tokensData,
		sessionsData: dailyPeriod.sessionsData,
		modelDatasets: dailyPeriod.modelDatasets,
		editorDatasets: dailyPeriod.editorDatasets,
		repositoryDatasets: dailyPeriod.repositoryDatasets,
		taskCategoryDatasets: dailyPeriod.taskCategoryDatasets,
		editorTotalsMap,
		repositoryTotalsMap,
		dailyCount: dailyPeriod.periodCount,
		totalTokens: dailyPeriod.totalTokens,
		avgTokensPerDay: dailyPeriod.avgPerPeriod,
		totalSessions: dailyPeriod.totalSessions,
		lastUpdated: now.toISOString(),
		backendConfigured: deps.backendConfigured,
		compactNumbers: deps.compactNumbers,
		periods: {
			day: dailyPeriod,
			week: weeklyPeriod,
			month: monthlyPeriod,
		},
		hasLocData,
	};
}
