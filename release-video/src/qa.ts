/**
 * Stage 6 — check the rendered file before anyone watches it.
 *
 * These are the failures that are invisible in a log full of green steps and
 * obvious thirty seconds into playback: a video that came out silent because
 * the mix produced no audio stream, one that is seconds shorter than the
 * script because a transition ate a scene, or one whose narration is quiet
 * enough that viewers reach for the volume.
 *
 * Every check compares the file against the timeline the pipeline itself
 * computed, so the report is about *this* render rather than about generic
 * thresholds.
 */

import * as path from 'node:path';

import type { Config } from './config';
import type { Manifest } from './manifest';
import { probeSummary } from './media';
import { buildTimeline } from './timeline';
import { log, run } from './util';
import { formatClock } from './voice';

export interface QaFinding {
	readonly level: 'ok' | 'warn' | 'fail';
	readonly check: string;
	readonly detail: string;
}

export interface QaReport {
	readonly file: string;
	readonly findings: readonly QaFinding[];
	readonly passed: boolean;
}

/** How far the rendered duration may drift from the plan before it is suspicious. */
const DURATION_TOLERANCE_SECONDS = 1.5;

export async function qa(file: string, manifest: Manifest, config: Config): Promise<QaReport> {
	const summary = await probeSummary(config, file);
	const timeline = buildTimeline(manifest, config);
	const findings: QaFinding[] = [];

	const add = (level: QaFinding['level'], check: string, detail: string) => findings.push({ level, check, detail });

	if (summary.videoCodec) {
		add('ok', 'video stream', `${summary.videoCodec} ${summary.width}x${summary.height} @ ${(summary.fps ?? 0).toFixed(2)}fps`);
	} else {
		add('fail', 'video stream', 'the file has no video stream');
	}

	if (summary.width !== manifest.project.width || summary.height !== manifest.project.height) {
		add('fail', 'resolution', `expected ${manifest.project.width}x${manifest.project.height}, got ${summary.width}x${summary.height}`);
	}

	const hasNarration = manifest.scenes.some((scene) => scene.audio);
	if (!hasNarration) {
		// Not one scene has audio, so there is nothing to compare the file
		// against and every earlier version of this check passed trivially.
		// That is the blind spot: re-running `plan` rewrites the manifest
		// without the fields the `voice` stage fills in, so `build --from
		// render` then produces a silent video at the minimum scene length and
		// reports success. Even the `silence` engine writes real WAVs, so an
		// empty manifest always means the voice stage did not run.
		add('fail', 'narration', 'no scene has audio — run the `voice` stage (a re-plan clears it)');
	} else if (!summary.audioCodec) {
		add('fail', 'audio stream', 'narration was generated but the rendered file is silent');
	} else {
		add('ok', 'audio stream', summary.audioCodec);
	}

	// A failure, not a warning. `passed` ignores warnings, so a render that
	// silently lost a scene — which is exactly what the old `xfade duration=0`
	// hard cut did — would otherwise be reported as a successful build. The
	// whole point of this stage is that the file matches the plan; a file
	// materially shorter than the timeline does not.
	const drift = summary.durationSeconds - timeline.totalSeconds;
	if (Math.abs(drift) > DURATION_TOLERANCE_SECONDS) {
		add(
			'fail',
			'duration',
			`planned ${formatClock(timeline.totalSeconds)}, rendered ${formatClock(summary.durationSeconds)} ` +
			`(${drift > 0 ? '+' : ''}${drift.toFixed(2)}s) — a scene is likely missing or truncated`,
		);
	} else {
		add('ok', 'duration', `${formatClock(summary.durationSeconds)} (planned ${formatClock(timeline.totalSeconds)})`);
	}

	// A scene whose voice runs past its own crossfade gets talked over by the
	// next screen. It is legal, just usually not what anyone wanted.
	for (const entry of timeline.entries) {
		const speechEnd = entry.audioStart + entry.audioDuration;
		const sceneEnd = entry.start + entry.duration - entry.transitionOut;
		if (entry.audioDuration > 0 && speechEnd > sceneEnd + 0.05) {
			add('warn', `scene "${entry.scene.id}"`, `narration runs ${(speechEnd - sceneEnd).toFixed(2)}s past the transition into the next scene`);
		}
	}

	if (summary.audioCodec) {
		// 96 kHz here means `loudnorm`'s internal 192 kHz rate leaked into the
		// encoder because nothing resampled after it.
		if (summary.audioRate !== undefined && summary.audioRate > 48000) {
			add('fail', 'audio rate', `${summary.audioRate} Hz — something downstream of the mix is not resampling to 48 kHz`);
		}
		await checkLoudness(file, config, add);
	}

	const megabytes = (summary.sizeBytes ?? 0) / (1024 * 1024);
	add('ok', 'file size', `${megabytes.toFixed(1)} MB`);

	const failed = findings.filter((finding) => finding.level === 'fail');
	const warned = findings.filter((finding) => finding.level === 'warn');

	log.group(`QA — ${path.basename(file)}`);
	for (const finding of findings) {
		const marker = finding.level === 'fail' ? '✗' : finding.level === 'warn' ? '!' : '✓';
		log.info(`${marker} ${finding.check}: ${finding.detail}`);
	}
	log.info(failed.length === 0
		? `Passed${warned.length > 0 ? ` with ${warned.length} warning(s)` : ''}`
		: `${failed.length} failure(s)`);
	log.groupEnd();

	return { file, findings, passed: failed.length === 0 };
}

/** Integrated loudness target and how far the render may sit from it. */
const TARGET_LUFS = -16;
const LUFS_TOLERANCE = 2;

/**
 * The loudness range below which narration has genuinely been squashed.
 *
 * Deliberately low, because single-voice synthetic narration is naturally flat:
 * an untouched SAPI WAV out of this pipeline measures about 2.9 LU, and a
 * neural voice is not much wider. A threshold set at a music-like 4 LU would
 * warn on every correct render, which trains you to ignore it.
 *
 * Below 2 LU something has actually compressed the audio — a limiter set too
 * hard, or `loudnorm` falling back to riding the gain.
 */
const MIN_LOUDNESS_RANGE = 2;

async function checkLoudness(
	file: string,
	config: Config,
	add: (level: QaFinding['level'], check: string, detail: string) => void,
): Promise<void> {
	const measured = await measureLoudness(config, file);
	if (!measured) {
		add('warn', 'loudness', 'could not be measured');
		return;
	}

	const { integrated, range, truePeak } = measured;
	const drift = integrated - TARGET_LUFS;

	if (Math.abs(drift) > LUFS_TOLERANCE) {
		add('warn', 'loudness', `${integrated.toFixed(1)} LUFS, ${Math.abs(drift).toFixed(1)} LU from the ${TARGET_LUFS} target`);
	} else {
		add('ok', 'loudness', `${integrated.toFixed(1)} LUFS, peak ${truePeak.toFixed(1)} dBTP`);
	}

	if (range < MIN_LOUDNESS_RANGE) {
		add('warn', 'dynamics', `loudness range is only ${range.toFixed(1)} LU — the narration sounds compressed, check for gain riding`);
	} else {
		add('ok', 'dynamics', `${range.toFixed(1)} LU loudness range`);
	}

	if (truePeak > -0.5) {
		add('warn', 'true peak', `${truePeak.toFixed(2)} dBTP is close enough to full scale to distort on some players`);
	}
}

async function measureLoudness(
	config: Config,
	file: string,
): Promise<{ integrated: number; range: number; truePeak: number } | null> {
	try {
		const { stderr } = await run(config.tools.ffmpeg, [
			'-hide_banner', '-nostats',
			'-i', file,
			'-af', 'loudnorm=print_format=json',
			'-f', 'null', '-',
		], { check: false, timeoutMs: 600000 });

		const start = stderr.lastIndexOf('{');
		const end = stderr.lastIndexOf('}');
		if (start === -1 || end <= start) { return null; }

		const parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
		const integrated = Number(parsed.input_i);
		const range = Number(parsed.input_lra);
		const truePeak = Number(parsed.input_tp);
		if (![integrated, range, truePeak].every(Number.isFinite)) { return null; }
		return { integrated, range, truePeak };
	} catch {
		return null;
	}
}
