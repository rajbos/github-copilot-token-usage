/**
 * Optional narration polish with a local model.
 *
 * ## What the model is and is not allowed to do
 *
 * It rewrites **prose only**. It is handed the scene ids and the draft
 * narration already derived from the release catalog, and the only thing read
 * back out of its response is a narration string per known id. Timings, file
 * paths, motion, transitions and coordinates are never sent for rewriting and
 * are never read back — they are computed in `plan.ts` and `render.ts` from
 * validated inputs.
 *
 * That restriction is what makes it safe to run this against whatever model
 * happens to be loaded: the worst a bad response can do is produce narration
 * that reads poorly, which a human notices immediately when they watch the
 * first cut. Anything unexpected in the response — an unknown id, a non-string
 * value, a truncated JSON body — falls back to the deterministic draft rather
 * than failing the build, because a slightly stiff sentence is a much better
 * outcome than no video.
 *
 * With `llm.enabled: false` (the default) the pipeline never contacts a model
 * and still produces a complete script.
 */

import type { ResolvedRelease } from './catalog';
import type { Config } from './config';
import { validateManifest, type Manifest } from './manifest';
import { capWords, countWords, toSpokenText } from './speech';
import { log } from './util';

/** The shape the model must answer in. Enforced server-side where supported. */
const RESPONSE_SCHEMA = {
	type: 'object',
	properties: {
		scenes: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					narration: { type: 'string' },
				},
				required: ['id', 'narration'],
			},
		},
	},
	required: ['scenes'],
} as const;

function buildPrompt(manifest: Manifest, release: ResolvedRelease, maxWords: number): string {
	const scenes = manifest.scenes.map((scene) => ({
		id: scene.id,
		title: scene.title,
		draft: scene.narration,
	}));

	return [
		'You are the narrator of a short product update video. You are speaking',
		'to someone watching their screen, who cannot see any text you do not say.',
		'',
		`Product: ${manifest.project.title}`,
		`Release headline: ${release.headline}`,
		'',
		'Each draft below is already correct and already says where the feature',
		'lives. Your job is to make it sound like a person talking, not like a',
		'changelog being read out, and to make the scenes flow into each other.',
		'',
		'Voice:',
		'- Narrate. "Over in the Usage Analysis view, there is a new tab called',
		'  Corrections. It shows the moments where things went sideways..."',
		'- Never a label followed by a fragment. Not "Corrections tab: a new',
		'  tab. Shows the moments where..." — every sentence needs a subject.',
		'- Say where we are when the view changes, and do not repeat it when it',
		'  has not. The drafts are in running order, so use that.',
		'- Say why a viewer would care, when the draft gives you grounds to.',
		'- Contractions are good. Long subordinate clauses are not: a listener',
		'  cannot re-read a sentence.',
		'',
		'Rules:',
		`- At most ${maxWords} words per scene. Shorter is better.`,
		'- Plain spoken English. No markdown, no bullet points, no headings.',
		'- Do not invent features, numbers or behaviour that is not in the draft.',
		'- Do not read out file paths, settings ids or URLs.',
		'- Do not refer to the video itself, or to "this scene".',
		'- Keep every scene id exactly as given.',
		'',
		'Scenes, in the order they are shown:',
		JSON.stringify(scenes, null, 2),
		'',
		'Answer with JSON only: {"scenes":[{"id":"...","narration":"..."}]}',
	].join('\n');
}

export async function polishNarration(
	manifest: Manifest,
	config: Config,
	release: ResolvedRelease,
): Promise<Manifest> {
	const prompt = buildPrompt(manifest, release, config.llm.maxWordsPerScene);
	log.group(`Polishing narration with ${config.llm.model} (${config.llm.provider})`);

	assertLocalNarrationDestination(config.llm.endpoint, config.llm.allowRemote ?? false);

	let rewritten: Map<string, string>;
	try {
		const raw = config.llm.provider === 'ollama'
			? await callOllama(prompt, config)
			: await callOpenAiCompatible(prompt, config);
		rewritten = parseResponse(raw, manifest, config.llm.maxWordsPerScene);
		log.info(`Model rewrote ${rewritten.size} of ${manifest.scenes.length} scene(s)`);
	} catch (error) {
		log.warn(`Model polish failed, keeping the catalog-derived script: ${(error as Error).message}`);
		rewritten = new Map();
	} finally {
		log.groupEnd();
	}

	return validateManifest({
		...manifest,
		scenes: manifest.scenes.map((scene) => ({
			...scene,
			narration: rewritten.get(scene.id) ?? capWords(scene.narration, config.llm.maxWordsPerScene),
		})),
	});
}

/**
 * Refuses to send the narration text to a non-loopback host unless the config
 * opts in with `llm.allowRemote`.
 *
 * `endpoint` is a config value, and the prompt carries the release narration.
 * Local models are the documented setup, so anything else must be deliberate —
 * mirrors the `allowOtherHosts` guard on the Mistral adapter in `voice.ts`.
 */
export function assertLocalNarrationDestination(endpoint: string, allowRemote: boolean): void {
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch {
		throw new Error(`llm.endpoint is not a valid URL: ${endpoint}`);
	}

	const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
	if (isLoopback) { return; }
	if (!allowRemote) {
		throw new Error(
			`refusing to send narration to ${parsed.hostname} — llm.endpoint must be loopback. ` +
			'To use a hosted model, set llm.allowRemote to true in config.json, and be sure you ' +
			'trust that host with the release text.',
		);
	}
	log.warn(`Sending narration to ${parsed.hostname}, which is not loopback (llm.allowRemote is on)`);
}

async function callOllama(prompt: string, config: Config): Promise<string> {
	const response = await fetchJson(`${trimSlash(config.llm.endpoint)}/api/chat`, {
		model: config.llm.model,
		stream: false,
		format: RESPONSE_SCHEMA,
		options: { temperature: config.llm.temperature },
		messages: [{ role: 'user', content: prompt }],
	}, config.llm.timeoutMs);

	const content = (response as { message?: { content?: string } }).message?.content;
	if (typeof content !== 'string') {
		throw new Error('Ollama response had no message.content');
	}
	return content;
}

async function callOpenAiCompatible(prompt: string, config: Config): Promise<string> {
	const response = await fetchJson(`${trimSlash(config.llm.endpoint)}/v1/chat/completions`, {
		model: config.llm.model,
		temperature: config.llm.temperature,
		messages: [{ role: 'user', content: prompt }],
		response_format: {
			type: 'json_schema',
			json_schema: { name: 'narration', strict: true, schema: RESPONSE_SCHEMA },
		},
	}, config.llm.timeoutMs);

	const content = (response as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
	if (typeof content !== 'string') {
		throw new Error('response had no choices[0].message.content');
	}
	return content;
}

async function fetchJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`${url} returned ${response.status} ${response.statusText}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Reads narration back out of a model response.
 *
 * Tolerant about the envelope (a reasoning model may wrap JSON in prose or a
 * fenced block) and strict about the contents: unknown ids are dropped, empty
 * or non-string narration is dropped, and everything kept is re-normalized
 * through the same spoken-text and word-cap passes the deterministic path uses.
 */
function parseResponse(raw: string, manifest: Manifest, maxWords: number): Map<string, string> {
	const known = new Set(manifest.scenes.map((scene) => scene.id));
	const result = new Map<string, string>();

	const jsonText = extractJsonObject(raw);
	if (!jsonText) { throw new Error('no JSON object found in the response'); }

	const parsed = JSON.parse(jsonText) as { scenes?: unknown };
	if (!Array.isArray(parsed.scenes)) { throw new Error('response has no "scenes" array'); }

	for (const entry of parsed.scenes) {
		if (!entry || typeof entry !== 'object') { continue; }
		const { id, narration } = entry as { id?: unknown; narration?: unknown };
		if (typeof id !== 'string' || !known.has(id)) { continue; }
		if (typeof narration !== 'string' || narration.trim().length < 3) { continue; }
		const cleaned = capWords(toSpokenText(narration), maxWords);
		if (countWords(cleaned) === 0) { continue; }
		result.set(id, cleaned);
	}
	return result;
}

/** Finds the outermost balanced `{...}`, ignoring fences and thinking preamble. */
function extractJsonObject(text: string): string | null {
	const start = text.indexOf('{');
	if (start === -1) { return null; }
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) { escaped = false; } else if (char === '\\') { escaped = true; } else if (char === '"') { inString = false; }
			continue;
		}
		if (char === '"') { inString = true; } else if (char === '{') { depth++; } else if (char === '}') {
			depth--;
			if (depth === 0) { return text.slice(start, i + 1); }
		}
	}
	return null;
}

function trimSlash(url: string): string {
	return url.replace(/\/+$/, '');
}
