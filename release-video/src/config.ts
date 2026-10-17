/** Typed view of `config.json`, with the `$comment` documentation stripped. */

import * as path from 'node:path';

import { PROJECT_ROOT, readJson, stripComments } from './util';

export type VoiceEngine = 'mistral' | 'voicebox' | 'sapi' | 'command' | 'silence';

export interface Config {
	readonly project: {
		readonly width: number;
		readonly height: number;
		readonly fps: number;
		readonly theme: 'dark' | 'light';
		readonly productName: string;
	};
	readonly branding: {
		/** Repo-root-relative path to the product logo. */
		readonly logo: string;
		readonly repoUrl: string;
		readonly tagline: string;
		readonly marketplaces: readonly { readonly name: string; readonly logo: string }[];
	};
	readonly tools: { readonly ffmpeg: string; readonly ffprobe: string };
	readonly encode: {
		readonly encoder: string;
		readonly preset: string;
		readonly tune: string;
		readonly rateControl: string;
		readonly cq: number;
		readonly audioBitrate: string;
	};
	readonly motion: {
		readonly zoomFrom: number;
		readonly zoomTo: number;
		readonly transition: string;
		readonly transitionSeconds: number;
		readonly paddingSeconds: number;
		readonly minSceneSeconds: number;
	};
	readonly voice: {
		readonly engine: VoiceEngine;
		readonly voicebox: {
			readonly endpoint: string;
			/** Path appended to `endpoint`. Local TTS servers disagree on this. */
			readonly path: string;
			readonly model: string;
			readonly referenceWav: string;
			readonly referenceText: string;
			readonly exaggeration: number;
			readonly cfgWeight: number;
			readonly timeoutMs: number;
			/** Merged into the request body verbatim, for server-specific fields. */
			readonly extra: Readonly<Record<string, unknown>>;
		};
		/**
		 * Hosted TTS. The only engine here that leaves the machine — see the
		 * `$comment` in config.json.
		 */
		readonly mistral: {
			readonly endpoint: string;
			readonly path: string;
			readonly model: string;
			readonly voiceId: string;
			readonly responseFormat: string;
			/** Name of the env var holding the key. Never the key itself. */
			readonly apiKeyEnv: string;
			/** The only host the key is sent to, matched exactly. */
			readonly expectedHost: string;
			/** Opt in to sending the key to a different host entirely. */
			readonly allowOtherHosts: boolean;
			readonly timeoutMs: number;
		};
		readonly sapi: { readonly voiceName: string; readonly rate: number };
		readonly command: { readonly argv: readonly string[]; readonly stdinText: boolean };
	};
	readonly llm: {
		readonly enabled: boolean;
		readonly provider: 'ollama' | 'openai-compatible';
		readonly endpoint: string;
		/**
		 * The narration text is sent to `endpoint`. Only loopback is accepted
		 * unless this is true, so a hosted model is always a deliberate choice.
		 */
		readonly allowRemote?: boolean;
		readonly model: string;
		readonly temperature: number;
		readonly timeoutMs: number;
		readonly maxWordsPerScene: number;
	};
	readonly subtitles: {
		readonly enabled: boolean;
		readonly align: boolean;
		readonly whisperCommand: string;
		readonly whisperModel: string;
		readonly fontName: string;
		readonly fontSize: number;
		readonly marginV: number;
	};
}

export const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

export function loadConfig(file = CONFIG_PATH): Config {
	return stripComments(readJson<Config>(file));
}

/** Well-known locations, all relative to the project root. */
export const paths = {
	content: path.join(PROJECT_ROOT, 'content'),
	manifest: path.join(PROJECT_ROOT, 'content', 'manifest.json'),
	pronunciation: path.join(PROJECT_ROOT, 'pronunciation.json'),
	assets: path.join(PROJECT_ROOT, 'assets'),
	screenshots: path.join(PROJECT_ROOT, 'assets', 'screenshots'),
	cards: path.join(PROJECT_ROOT, 'assets', 'cards'),
	cache: path.join(PROJECT_ROOT, 'cache'),
	narration: path.join(PROJECT_ROOT, 'cache', 'narration'),
	scenes: path.join(PROJECT_ROOT, 'cache', 'scenes'),
	subtitles: path.join(PROJECT_ROOT, 'cache', 'subtitles'),
	filtergraphs: path.join(PROJECT_ROOT, 'cache', 'filtergraphs'),
	output: path.join(PROJECT_ROOT, 'output'),
} as const;
