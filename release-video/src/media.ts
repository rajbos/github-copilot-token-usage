/** Thin, typed wrappers over ffprobe/ffmpeg. No shell, ever — argv arrays only. */

import type { Config } from './config';
import { run } from './util';

/**
 * Duration of a media file in seconds, read from the container.
 *
 * This is the pipeline's timing authority. Scene lengths are derived from the
 * narration audio that was actually generated — never from an estimate, and
 * never from what a model predicted the sentence would take. That rule is what
 * stops narration from being cut off mid-word when a sentence runs long.
 */
export async function probeDuration(config: Config, file: string): Promise<number> {
	const { stdout } = await run(config.tools.ffprobe, [
		'-v', 'error',
		'-show_entries', 'format=duration',
		'-of', 'default=noprint_wrappers=1:nokey=1',
		file,
	], { timeoutMs: 60000 });

	const seconds = Number(stdout.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`ffprobe reported no usable duration for ${file} (got "${stdout.trim()}")`);
	}
	return seconds;
}

export interface StreamSummary {
	readonly durationSeconds: number;
	readonly width?: number;
	readonly height?: number;
	readonly videoCodec?: string;
	readonly audioCodec?: string;
	readonly audioRate?: number;
	readonly fps?: number;
	readonly sizeBytes?: number;
}

/** Everything the QA stage checks, in one ffprobe call. */
export async function probeSummary(config: Config, file: string): Promise<StreamSummary> {
	const { stdout } = await run(config.tools.ffprobe, [
		'-v', 'error',
		'-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate',
		'-of', 'json',
		file,
	], { timeoutMs: 60000 });

	const parsed = JSON.parse(stdout) as {
		format?: { duration?: string; size?: string };
		streams?: {
			codec_type?: string; codec_name?: string; width?: number; height?: number;
			avg_frame_rate?: string; sample_rate?: string;
		}[];
	};

	const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
	const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');

	return {
		durationSeconds: Number(parsed.format?.duration ?? 0),
		...(video?.width !== undefined ? { width: video.width } : {}),
		...(video?.height !== undefined ? { height: video.height } : {}),
		...(video?.codec_name !== undefined ? { videoCodec: video.codec_name } : {}),
		...(audio?.codec_name !== undefined ? { audioCodec: audio.codec_name } : {}),
		...(audio?.sample_rate !== undefined ? { audioRate: Number(audio.sample_rate) } : {}),
		...(video?.avg_frame_rate ? { fps: parseFraction(video.avg_frame_rate) } : {}),
		...(parsed.format?.size !== undefined ? { sizeBytes: Number(parsed.format.size) } : {}),
	};
}

function parseFraction(value: string): number {
	const [numerator, denominator] = value.split('/').map(Number);
	if (!numerator || !denominator) { return Number(value) || 0; }
	return numerator / denominator;
}

/** Writes a silent WAV of a given length. Used by the `silence` voice engine. */
export async function writeSilence(config: Config, file: string, seconds: number): Promise<void> {
	await run(config.tools.ffmpeg, [
		'-y', '-hide_banner', '-loglevel', 'error',
		'-f', 'lavfi',
		'-i', `anullsrc=channel_layout=mono:sample_rate=24000`,
		'-t', seconds.toFixed(3),
		'-c:a', 'pcm_s16le',
		file,
	], { timeoutMs: 60000 });
}

/**
 * Re-encodes any TTS output to the one audio format the rest of the pipeline
 * assumes: 24 kHz mono 16-bit PCM.
 *
 * Engines disagree about sample rate and channel count, and a mismatch shows
 * up much later as an FFmpeg filter error deep inside the assembly graph.
 * Normalizing at the boundary keeps that class of failure out entirely.
 */
export async function normalizeWav(config: Config, input: string, output: string): Promise<void> {
	await run(config.tools.ffmpeg, [
		'-y', '-hide_banner', '-loglevel', 'error',
		'-i', input,
		'-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
		output,
	], { timeoutMs: 120000 });
}
