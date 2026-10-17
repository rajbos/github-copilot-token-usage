/**
 * Stage 5 — render the scenes, then assemble them.
 *
 * ## Why two passes
 *
 * One giant `-filter_complex` covering a dozen screenshots, a dozen Ken Burns
 * moves, a dozen crossfades and a mix is the classic way to build this — and
 * it is miserable. A typo in scene nine fails the whole render after several
 * minutes, with an error that names a label rather than a scene, and every
 * re-run redoes all the work.
 *
 * So each scene is rendered to its own short MP4, content-addressed on
 * everything that affects its pixels. Change one screenshot or one duration
 * and exactly one scene re-renders. The assembly pass is then a simple chain
 * of `xfade` over finished clips, which is both fast and easy to reason about.
 *
 * ## Where the filter graph lives
 *
 * Never on a command line. Both passes write `-filter_complex_script` files
 * into `cache/filtergraphs/`, which avoids every layer of shell and
 * PowerShell quoting and — more usefully — leaves the exact graph on disk to
 * read when a render does fail.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { paths, type Config } from './config';
import type { Manifest, Scene } from './manifest';
import { buildTimeline, type Timeline, type TimelineEntry } from './timeline';
import { digest, ensureDir, log, PROJECT_ROOT, resolveInProject, run } from './util';
import { formatClock } from './voice';

/** Sample rate everything downstream of the mix runs at. */
const AUDIO_RATE = 48000;

/** EBU R128 target: the level streaming platforms normalize to anyway. */
const LOUDNORM_TARGET = 'loudnorm=I=-16:LRA=7:TP=-1.5';

/** Integrated loudness to land on, in LUFS. */
const TARGET_LUFS = -16;

/** Ceiling for sample peaks, as linear amplitude. -1.5 dBFS. */
const PEAK_CEILING = 0.841;

export interface RenderOptions {
	readonly output?: string;
	readonly subtitleFile?: string | null;
	/** Re-render scenes even when a cached clip matches. */
	readonly force?: boolean;
}

export async function render(manifest: Manifest, config: Config, options: RenderOptions = {}): Promise<string> {
	const timeline = buildTimeline(manifest, config);
	ensureDir(paths.scenes);
	ensureDir(paths.filtergraphs);
	ensureDir(paths.output);

	log.group(`Rendering ${manifest.scenes.length} scenes — ${formatClock(timeline.totalSeconds)} final runtime`);

	const clips: string[] = [];
	for (const entry of timeline.entries) {
		clips.push(await renderScene(entry, manifest, config, options.force ?? false));
	}

	const output = options.output
		? resolveInProject(options.output, 'output')
		: path.join(paths.output, `${slugForFile(manifest.project.title)}.mp4`);

	await assemble(clips, timeline, manifest, config, output, options.subtitleFile ?? null);

	log.info(`✓ ${path.relative(process.cwd(), output)}`);
	log.groupEnd();
	return output;
}

/* ------------------------------------------------------------------ scenes */

/**
 * Renders one scene to a silent MP4 and returns its path.
 *
 * The cache key covers the image *bytes*, not just its path — re-capturing
 * screenshots after a UI change therefore invalidates exactly the scenes whose
 * pixels moved.
 */
async function renderScene(entry: TimelineEntry, manifest: Manifest, config: Config, force: boolean): Promise<string> {
	const { scene, duration } = entry;
	const imagePath = resolveInProject(scene.image, `scene ${scene.id} image`);
	const key = digest(
		fs.readFileSync(imagePath),
		scene.motion,
		duration,
		manifest.project.width,
		manifest.project.height,
		manifest.project.fps,
		config.encode,
	);
	const clip = path.join(paths.scenes, `${scene.id}-${key}.mp4`);

	if (!force && fs.existsSync(clip)) {
		log.info(`${scene.id} — cached clip`);
		return clip;
	}

	const graphFile = path.join(paths.filtergraphs, `scene-${scene.id}.txt`);
	fs.writeFileSync(graphFile, sceneFilterGraph(entry, manifest), 'utf8');

	// The image is fed as a SINGLE frame, not looped.
	//
	// `zoompan` emits `d` output frames for every *input* frame it receives. With
	// `-loop 1 -t 6` the image decoder hands it ~150 frames and it dutifully
	// produces 150 x d of them — a six-second scene renders as a twenty-minute,
	// 300 MB clip. Given one frame it produces exactly `d`, which is the whole
	// scene, and the output length follows from `d` and `fps`.
	await run(config.tools.ffmpeg, [
		'-y', '-hide_banner', '-loglevel', 'error', '-stats',
		'-i', imagePath,
		'-filter_complex_script', graphFile,
		'-map', '[v]',
		'-an',
		'-frames:v', String(Math.max(2, Math.round(duration * manifest.project.fps))),
		'-r', String(manifest.project.fps),
		...encoderArgs(config, { quality: 'intermediate' }),
		'-pix_fmt', 'yuv420p',
		clip,
	], { timeoutMs: 900000, stream: false });

	log.info(`${scene.id} — rendered ${duration.toFixed(2)}s`);
	return clip;
}

/**
 * How much the image is upscaled before `zoompan` sees it.
 *
 * This is the whole ballgame for smooth motion. `zoompan` crops in **integer
 * source pixels**, so if the crop rectangle changes by less than one pixel
 * between two output frames, those frames come out byte-identical and the move
 * stutters. A 1.0→1.07 zoom held across a twenty-second scene moves the crop
 * edge about 0.4 px per frame at 2x — so roughly every other frame was a
 * duplicate, which is exactly what a frame-difference trace of the first cut
 * showed.
 *
 * Rather than hard-code a factor and hope, solve for it. The crop width sweeps
 * `width * S * |1/from - 1/to|` pixels over `frames` frames, so requiring at
 * least one pixel of change per frame gives the S below. Clamped at 6 because
 * the supersampled frame is held in memory: 6x of 1080p is already 11520x6480.
 */
export function supersampleFor(motion: Scene['motion'], frames: number, width: number): number {
	const span = Math.abs(1 / motion.from - 1 / motion.to);
	if (span < 1e-6) { return 2; }
	const needed = frames / (width * span);
	return Math.min(6, Math.max(2, Math.ceil(needed)));
}

/**
 * Scale, pad and Ken Burns for one still image.
 *
 * The supersampled frame is what `zoompan` crops from; see
 * {@link supersampleFor} for why its size is computed rather than fixed.
 */
function sceneFilterGraph(entry: TimelineEntry, manifest: Manifest): string {
	const { width, height, fps } = manifest.project;
	const frames = Math.max(2, Math.round(entry.duration * fps));
	const supersample = supersampleFor(entry.scene.motion, frames, width);

	return [
		'[0:v]',
		`scale=${width}:${height}:force_original_aspect_ratio=decrease,`,
		`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#1e1e1e,`,
		`scale=${width * supersample}:${height * supersample}:flags=lanczos,`,
		`${zoompanExpression(entry.scene.motion, frames, width, height, fps)},`,
		'setsar=1,',
		'format=yuv420p',
		'[v]',
	].join('');
}

/**
 * The `zoompan` call for a motion preset.
 *
 * `on` is the output frame index, so `on/(frames-1)` is a 0..1 progress ramp —
 * which is all any of these moves need. The x/y expressions keep the focus
 * point stationary in the frame while the crop shrinks around it: at zoom `z`
 * the crop is `iw/z` wide, leaving `iw - iw/z` to distribute, and putting
 * `focusX` of that to the left of the crop holds the focus in place.
 */
function zoompanExpression(motion: Scene['motion'], frames: number, width: number, height: number, fps: number): string {
	const span = Math.max(1, frames - 1);
	const ramp = `(on/${span})`;
	const clampFocus = (value: number) => Math.min(1, Math.max(0, value)).toFixed(4);

	let zoom: string;
	let x: string;
	let y: string;

	switch (motion.type) {
		case 'still':
			zoom = motion.from.toFixed(4);
			x = `(iw-iw/zoom)*${clampFocus(motion.focusX)}`;
			y = `(ih-ih/zoom)*${clampFocus(motion.focusY)}`;
			break;
		case 'pan-right':
		case 'pan-left': {
			// A pan slides the crop across, staying on the focus row so a
			// measured anchor is still what you are looking at.
			//
			// It also drifts the zoom rather than holding it fixed. A constant
			// zoom keeps the crop *size* constant, so the only thing changing is
			// x — and on a long scene x moves well under a pixel per frame,
			// which brings back the duplicate frames this is all trying to
			// avoid. Drifting the zoom means the crop rectangle changes every
			// frame, and the drift is small enough to read as a pan.
			zoom = `${motion.from.toFixed(4)}+(${(motion.to - motion.from).toFixed(4)})*${ramp}`;
			const progress = motion.type === 'pan-right' ? ramp : `(1-${ramp})`;
			// Travel only the middle of the image so the move never hits the edge
			// and stop dead, which reads as a glitch rather than as a pan.
			x = `(iw-iw/zoom)*(0.18+0.64*${progress})`;
			y = `(ih-ih/zoom)*${clampFocus(motion.focusY)}`;
			break;
		}
		case 'zoom-out':
		case 'zoom-in':
		default:
			zoom = `${motion.from.toFixed(4)}+(${(motion.to - motion.from).toFixed(4)})*${ramp}`;
			x = `(iw-iw/zoom)*${clampFocus(motion.focusX)}`;
			y = `(ih-ih/zoom)*${clampFocus(motion.focusY)}`;
			break;
	}

	return `zoompan=z='${zoom}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${fps}`;
}

/* ---------------------------------------------------------------- assembly */

async function assemble(
	clips: readonly string[],
	timeline: Timeline,
	manifest: Manifest,
	config: Config,
	output: string,
	subtitleFile: string | null,
): Promise<void> {
	const audioFiles = timeline.entries
		.map((entry) => entry.scene.audio)
		.filter((audio): audio is string => typeof audio === 'string');

	const inputs: string[] = [];
	for (const clip of clips) { inputs.push('-i', clip); }
	for (const audio of audioFiles) { inputs.push('-i', resolveInProject(audio, 'narration')); }

	const loudnessFilter = audioFiles.length > 0
		? await measureLoudness(timeline, clips.length, audioFiles, config)
		: LOUDNORM_TARGET;

	const graph = assemblyFilterGraph(timeline, clips.length, audioFiles.length, subtitleFile, config, loudnessFilter);
	const graphFile = path.join(paths.filtergraphs, 'assemble.txt');
	fs.writeFileSync(graphFile, graph, 'utf8');

	log.info(`Assembling — graph at ${path.relative(process.cwd(), graphFile)}`);

	const map = audioFiles.length > 0 ? ['-map', '[v]', '-map', '[a]'] : ['-map', '[v]', '-an'];

	await run(config.tools.ffmpeg, [
		'-y', '-hide_banner', '-loglevel', 'error', '-stats',
		...inputs,
		'-filter_complex_script', graphFile,
		...map,
		'-r', String(manifest.project.fps),
		...encoderArgs(config, { quality: 'final' }),
		'-pix_fmt', 'yuv420p',
		...(audioFiles.length > 0 ? ['-c:a', 'aac', '-b:a', config.encode.audioBitrate, '-ar', String(AUDIO_RATE)] : []),
		'-movflags', '+faststart',
		output,
	], { timeoutMs: 1800000, stream: true });
}

/**
 * The crossfade chain, the subtitle burn-in and the narration mix.
 *
 * `xfade`'s `offset` is measured on the *chain built so far*, not on the
 * original clips — the whole reason the timeline module exists. Each fade
 * happens `transitionOut` seconds before the accumulated chain ends.
 */
export function assemblyFilterGraph(
	timeline: Timeline,
	clipCount: number,
	audioCount: number,
	subtitleFile: string | null,
	config: Config,
	loudnessFilter: string = LOUDNORM_TARGET,
): string {
	const lines: string[] = [];

	let currentLabel = '0:v';

	for (let i = 1; i < clipCount; i++) {
		const previous = timeline.entries[i - 1];
		const entry = timeline.entries[i];
		if (!previous || !entry) { continue; }

		const transition = previous.transitionOut;
		// The chain's length after i-1 fades is exactly where the timeline says
		// scene i starts — so reading the offset straight off the timeline is
		// both simpler than re-deriving it and guaranteed to agree with the
		// subtitle timings, which come from the same numbers.
		const offset = entry.start;
		const outLabel = `vx${i}`;

		if (transition <= 0) {
			// A hard cut uses concat, NOT xfade with duration=0.
			//
			// `xfade=duration=0` looks like a cut and exits 0, but it discards
			// the second input entirely: joining two three-second clips that
			// way yields 3.03s rather than 6s. Because it fails silently, the
			// only symptom is a scene missing from the finished video.
			//
			// concat appends exactly, which is what the timeline already
			// assumes for a zero-length transition, so no offset is involved.
			lines.push(`[${currentLabel}][${i}:v]concat=n=2:v=1:a=0[${outLabel}]`);
		} else {
			const name = previous.transitionName === 'none' ? 'fade' : previous.transitionName;
			lines.push(
				`[${currentLabel}][${i}:v]xfade=transition=${name}:duration=${transition.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`,
			);
		}

		currentLabel = outLabel;
	}

	if (subtitleFile) {
		lines.push(`[${currentLabel}]subtitles=filename='${escapeFilterPath(subtitleFile)}'[v]`);
	} else {
		lines.push(`[${currentLabel}]null[v]`);
	}

	if (audioCount > 0) {
		const delayed: string[] = [];
		timeline.entries.forEach((entry, index) => {
			if (!entry.scene.audio) { return; }
			const inputIndex = clipCount + delayed.length;
			const delayMs = Math.round(entry.audioStart * 1000);
			// `all=1` delays every channel; without it only the first is moved and
			// a stereo clip arrives half a scene early.
			lines.push(`[${inputIndex}:a]aresample=${AUDIO_RATE}:resampler=soxr,adelay=${delayMs}:all=1[a${index}]`);
			delayed.push(`[a${index}]`);
		});

		const mixed = delayed.length === 1 ? delayed[0] : '[amixed]';
		if (delayed.length > 1) {
			// normalize=0 keeps each clip at its own level; the default would
			// divide every scene's volume by the number of scenes.
			lines.push(`${delayed.join('')}amix=inputs=${delayed.length}:normalize=0:dropout_transition=0[amixed]`);
		}
		// EBU R128 to the streaming-platform target, so the video does not need
		// its volume adjusted relative to anything else you publish.
		//
		// The trailing aresample is not optional. `loudnorm` runs its internal
		// model at 192 kHz and *emits* at that rate, so without this the whole
		// mix reached the AAC encoder at 192 kHz and was written as a 96 kHz
		// stream — an unusual configuration that plays back badly.
		lines.push(`${mixed}${loudnessFilter},aresample=${AUDIO_RATE}:resampler=soxr[a]`);
	}

	return `${lines.join(';\n')}\n`;
}

/**
 * Measures the assembled mix so `loudnorm` can correct it **linearly**.
 *
 * Given only a target, `loudnorm` runs in single-pass mode: it adapts its gain
 * as it goes, which on speech pumps audibly — the level lifts during pauses and
 * ducks on loud syllables, and the result is described exactly the way you
 * would describe it, as choppy. Measuring first and passing the numbers back in
 * lets it apply one constant gain to the whole track instead.
 *
 * The analysis pass decodes audio only and writes nothing, so it costs a couple
 * of seconds. If it fails for any reason the single-pass target is returned:
 * slightly pumped audio beats no render.
 */
async function measureLoudness(
	timeline: Timeline,
	clipCount: number,
	audioFiles: readonly string[],
	config: Config,
): Promise<string> {
	const inputs: string[] = [];
	for (const audio of audioFiles) { inputs.push('-i', resolveInProject(audio, 'narration')); }

	// The same mix the real render builds, but with the video inputs absent, so
	// the audio input indices start at zero rather than after the clips.
	const graph = assemblyFilterGraph(timeline, clipCount, audioFiles.length, null, config, `${LOUDNORM_TARGET}:print_format=json`)
		.split(';\n')
		// Audio input lines, the mix, and the loudness filter. Written as three
		// explicit tests rather than one alternation: in
		// `/^\[\d+:a\]|amix=|loudnorm=/` the anchor binds only to the first
		// branch, which is what was meant but is not what it looks like.
		.filter((line) => /^\[\d+:a\]/.test(line) || line.includes('amix=') || line.includes('loudnorm='))
		.join(';\n')
		.replace(/\[(\d+):a\]/g, (_match, index: string) => `[${Number(index) - clipCount}:a]`);

	const graphFile = path.join(paths.filtergraphs, 'measure-loudness.txt');
	fs.writeFileSync(graphFile, `${graph}\n`, 'utf8');

	try {
		const { stderr } = await run(config.tools.ffmpeg, [
			'-hide_banner', '-nostats',
			...inputs,
			'-filter_complex_script', graphFile,
			'-map', '[a]',
			'-f', 'null', '-',
		], { check: false, timeoutMs: 600000 });

		const measured = parseLoudnormJson(stderr);
		if (!measured) { throw new Error('no measurement in ffmpeg output'); }

		const gainDb = TARGET_LUFS - Number(measured.input_i);
		log.info(
			`Measured ${measured.input_i} LUFS, true peak ${measured.input_tp} dBTP — ` +
			`applying ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(2)} dB with a peak limiter`,
		);
		return loudnessChain(gainDb);
	} catch (error) {
		log.warn(`Loudness measurement failed, falling back to single-pass: ${(error as Error).message.split(/\r?\n/)[0]}`);
		return LOUDNORM_TARGET;
	}
}

/**
 * One fixed gain, then a limiter on whatever still pokes through.
 *
 * `loudnorm` is not used for the correction itself, only for the measurement,
 * because of a trap in how it behaves: `linear=true` asks for a single constant
 * gain, but when that gain would push peaks past the true-peak ceiling,
 * loudnorm **silently reverts to its dynamic mode** and rides the gain instead.
 *
 * Synthetic narration walks straight into this. It measures around -19.9 LUFS
 * with peaks already at -0.2 dBFS — a peak-to-loudness ratio near 19.8 dB,
 * where -16 LUFS at -1.5 dBTP allows 14.5 — so the target is unreachable by
 * constant gain alone, and loudnorm quietly switches modes without saying so.
 *
 * Doing the correction here keeps it predictable: one measured gain, then a
 * limiter that acts only on the transients which would exceed the ceiling and
 * leaves everything below it alone. The integrated loudness lands a little
 * under target as a result, which the QA stage reports rather than hides.
 */
function loudnessChain(gainDb: number): string {
	return [
		`volume=${gainDb.toFixed(2)}dB`,
		// level=disabled stops alimiter from applying its own auto-gain on top,
		// which would undo the level just set.
		`alimiter=limit=${PEAK_CEILING}:attack=5:release=50:level=disabled`,
	].join(',');
}

interface LoudnormMeasurement {
	readonly input_i: string;
	readonly input_lra: string;
	readonly input_tp: string;
	readonly input_thresh: string;
	readonly target_offset: string;
}

/** Pulls the last JSON object out of ffmpeg's stderr, which is where loudnorm prints it. */
function parseLoudnormJson(stderr: string): LoudnormMeasurement | null {
	const start = stderr.lastIndexOf('{');
	const end = stderr.lastIndexOf('}');
	if (start === -1 || end <= start) { return null; }
	try {
		const parsed = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnormMeasurement>;
		// A measurement of "-inf" means silence; feeding that back would make
		// loudnorm apply an infinite gain.
		const values = [parsed.input_i, parsed.input_lra, parsed.input_tp, parsed.input_thresh, parsed.target_offset];
		if (values.some((value) => typeof value !== 'string' || !Number.isFinite(Number(value)))) { return null; }
		return parsed as LoudnormMeasurement;
	} catch {
		return null;
	}
}

function encoderArgs(config: Config, { quality }: { quality: 'intermediate' | 'final' }): string[] {
	const isNvenc = config.encode.encoder.includes('nvenc');
	// Intermediates are re-encoded once more during assembly, so they are kept
	// visibly better than the final to keep generation loss out of the result.
	const cq = quality === 'final' ? config.encode.cq : Math.max(1, config.encode.cq - 4);

	if (!isNvenc) {
		return ['-c:v', config.encode.encoder, '-preset', quality === 'final' ? 'slow' : 'veryfast', '-crf', String(cq)];
	}
	return [
		'-c:v', config.encode.encoder,
		'-preset', quality === 'final' ? config.encode.preset : 'p4',
		'-tune', config.encode.tune,
		'-rc', config.encode.rateControl,
		'-cq', String(cq),
		'-b:v', '0',
	];
}

/**
 * Escapes a Windows path for use inside a filter argument.
 *
 * The filter graph is parsed twice — once to split filters, once to split each
 * filter's options — so a drive letter's colon needs escaping even though the
 * graph comes from a file and never touches a shell.
 */
export function escapeFilterPath(file: string): string {
	// Separators first: ffmpeg accepts forward slashes everywhere, and on
	// Windows this also disposes of the backslashes that would otherwise need
	// escaping below. Deliberately `path.sep` rather than a blanket backslash
	// replacement — on POSIX a backslash is a legal character *in* a filename,
	// and rewriting it to a slash would silently point at a different file.
	const normalised = file.split(path.sep).join('/');

	// Then a single pass over every character the filter-graph parser treats
	// specially. Escaping them in separate passes is the classic incomplete
	// escape: whichever pass runs second adds backslashes the first would have
	// had to escape, so both orderings are wrong in different ways.
	return normalised.replace(/[\\':]/g, (character) => `\\${character}`);
}

function slugForFile(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'release';
}
