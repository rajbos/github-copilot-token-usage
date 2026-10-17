/**
 * Stage 4 — captions and title bands, timed against the audio that was
 * actually generated.
 *
 * Titles are rendered here, as a second ASS style, rather than with FFmpeg's
 * `drawtext`. One text engine means one place where fonts, escaping and
 * positioning can go wrong — and it sidesteps `drawtext`'s `fontfile`
 * argument, whose Windows drive-letter colon has to be escaped through two
 * layers of filter-graph parsing.
 *
 * Two levels of caption precision, both anchored to the real WAVs:
 *
 *   - **Sentence split (default).** The narration is split into sentences and
 *     each one gets a share of the scene's measured audio duration in
 *     proportion to its word count. No model, no extra dependency, and
 *     correct to within the natural variation of speaking rate inside one
 *     scene — which for a single synthetic voice is small.
 *   - **Forced alignment (`subtitles.align`).** Runs a Whisper CLI over each
 *     narration WAV for word-level timestamps and builds cues from those.
 *     Falls back to the sentence split, with a warning, when the CLI is not
 *     installed — a missing optional tool should cost you precision, not your
 *     video.
 *
 * Either way the timing authority is the WAV, never the text. That is the one
 * rule that keeps captions from drifting when a sentence takes longer to say
 * than it looks like it should.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { paths, type Config } from './config';
import type { Manifest } from './manifest';
import { countWords, splitSentences } from './speech';
import { buildTimeline, type TimelineEntry } from './timeline';
import { assTime, ensureDir, log, PROJECT_ROOT, resolveInProject, run } from './util';

interface Cue {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly style?: 'Narration' | 'Title';
}

/** How long a scene's title band stays on screen before it fades out. */
const TITLE_SECONDS = 3.4;

/**
 * Where a release's captions are written.
 *
 * `project.version` is validated as filename-safe by the manifest, and the
 * result is then resolved through the project allowlist anyway: this path is
 * built by string interpolation, and that is exactly the kind of place a
 * containment guarantee should not rest on a single upstream check.
 */
export function subtitleFileFor(manifest: Manifest): string {
	const relative = path.posix.join('cache', 'subtitles', `${manifest.project.version}.ass`);
	return resolveInProject(relative, 'subtitle file');
}

/** Writes the ASS file and returns its path, or null when subtitles are off. */
export async function generateSubtitles(manifest: Manifest, config: Config): Promise<string | null> {
	if (!config.subtitles.enabled) {
		log.info('Subtitles disabled in config');
		return null;
	}

	const timeline = buildTimeline(manifest, config);
	log.group('Building captions');

	const cues: Cue[] = [];
	for (const entry of timeline.entries) {
		// A scene with no title draws no band — the cards say their own name.
		if (entry.scene.title.trim()) { cues.push(titleCue(entry)); }
		const aligned = config.subtitles.align ? await alignScene(entry, config) : null;
		cues.push(...(aligned ?? splitByWordCount(entry)));
	}

	ensureDir(paths.subtitles);
	const file = subtitleFileFor(manifest);
	fs.writeFileSync(file, renderAss(cues, manifest, config), 'utf8');
	log.info(`${cues.length} cue(s) → ${path.relative(process.cwd(), file)}`);
	log.groupEnd();
	return file;
}

/**
 * The title band for a scene.
 *
 * It appears with the first frame of the scene — before the voice starts — so
 * the viewer reads the name of the thing a moment before hearing about it, and
 * it clears well before the crossfade so two titles are never on screen at
 * once.
 */
function titleCue(entry: TimelineEntry): Cue {
	const visible = Math.min(TITLE_SECONDS, Math.max(1.5, entry.duration - entry.transitionOut - 0.4));
	return {
		start: entry.start + 0.2,
		end: entry.start + 0.2 + visible,
		// \fad is an ASS override: fade in over 350ms, out over 450ms.
		text: `{\\fad(350,450)}${escapeAss(entry.scene.title)}`,
		style: 'Title',
	};
}

/**
 * Splits a scene's narration into cues, sharing the measured audio duration
 * between them by word count.
 *
 * Sentences are the natural unit, but the catalog writes long ones, and a
 * caption is capped at two lines so it does not cover the screenshot it is
 * explaining. A sentence that does not fit is therefore split across
 * consecutive cues rather than truncated — the words are still spoken either
 * way, so dropping them from the captions would leave deaf viewers with a
 * silently incomplete script.
 */
function splitByWordCount(entry: TimelineEntry): Cue[] {
	const chunks = splitSentences(entry.scene.narration).flatMap((sentence) => chunkToCaptionSize(sentence));

	const duration = entry.audioDuration > 0 ? entry.audioDuration : entry.duration;
	const totalWords = chunks.reduce((sum, chunk) => sum + countWords(chunk), 0) || 1;

	const cues: Cue[] = [];
	let cursor = entry.audioStart;
	for (const chunk of chunks) {
		const share = (countWords(chunk) / totalWords) * duration;
		cues.push({ start: cursor, end: cursor + share, text: wrapCaption(chunk) });
		cursor += share;
	}
	return cues;
}

/**
 * Word-level cues from a Whisper CLI.
 *
 * Returns null — rather than throwing — when the CLI is unavailable or its
 * output cannot be read, so alignment stays a strict upgrade over the
 * sentence split.
 */
async function alignScene(entry: TimelineEntry, config: Config): Promise<Cue[] | null> {
	const audio = entry.scene.audio;
	if (!audio) { return null; }

	const command = config.subtitles.whisperCommand;
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-align-'));

	try {
		await run(command, [
			path.join(PROJECT_ROOT, audio),
			'--model', config.subtitles.whisperModel,
			'--language', 'en',
			'--word_timestamps', 'True',
			'--output_format', 'json',
			'--output_dir', outDir,
		], { timeoutMs: 600000 });

		const jsonFile = fs.readdirSync(outDir).find((name) => name.endsWith('.json'));
		if (!jsonFile) { throw new Error('the aligner wrote no JSON'); }

		const parsed = JSON.parse(fs.readFileSync(path.join(outDir, jsonFile), 'utf8')) as {
			segments?: { start?: number; end?: number; text?: string }[];
		};
		const segments = (parsed.segments ?? []).filter(
			(segment) => typeof segment.start === 'number' && typeof segment.end === 'number' && segment.text?.trim(),
		);
		if (segments.length === 0) { throw new Error('the aligner found no speech'); }

		// A whisper segment can still be longer than a caption, so it goes
		// through the same chunking as the sentence split; each piece takes a
		// share of that segment's measured span.
		return segments.flatMap((segment) => {
			const start = entry.audioStart + (segment.start ?? 0);
			const end = entry.audioStart + (segment.end ?? 0);
			const chunks = chunkToCaptionSize((segment.text ?? '').trim());
			const totalWords = chunks.reduce((sum, chunk) => sum + countWords(chunk), 0) || 1;
			let cursor = start;
			return chunks.map((chunk) => {
				const share = (countWords(chunk) / totalWords) * Math.max(0, end - start);
				const cue: Cue = { start: cursor, end: cursor + share, text: wrapCaption(chunk) };
				cursor += share;
				return cue;
			});
		});
	} catch (error) {
		log.warn(`Alignment unavailable for ${entry.scene.id} (${(error as Error).message.split(/\r?\n/)[0]}); using the sentence split`);
		return null;
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
}

/**
 * Breaks text into pieces that each fit inside a two-line caption.
 *
 * It packs lines exactly the way {@link wrapCaption} will, then groups them
 * two at a time. Estimating instead — "two lines is about 124 characters" —
 * is off by however much the last word on each line overhangs, which is how
 * a 123-character sentence ends up needing three lines and losing its tail.
 */
function chunkToCaptionSize(text: string): string[] {
	const lines = packLines(text, CAPTION_LINE_CHARS);
	const chunks: string[] = [];
	for (let i = 0; i < lines.length; i += CAPTION_MAX_LINES) {
		chunks.push(lines.slice(i, i + CAPTION_MAX_LINES).join(' '));
	}
	return chunks.length > 0 ? chunks : [text];
}

/** Greedy word wrap. The one place line breaks are decided. */
function packLines(text: string, maxCharsPerLine: number): string[] {
	const lines: string[] = [];
	let line = '';
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (line && `${line} ${word}`.length > maxCharsPerLine) {
			lines.push(line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) { lines.push(line); }
	return lines;
}

/** How many characters fit on one caption line at the default font size. */
const CAPTION_LINE_CHARS = 62;

/** A caption that grows past two lines starts covering what it explains. */
const CAPTION_MAX_LINES = 2;

/**
 * Lays a chunk out as ASS line-broken text.
 *
 * Callers cut text to size with {@link chunkToCaptionSize} first. Reaching the
 * throw means words would be silently dropped from the captions while still
 * being spoken — better to fail the build than to ship that.
 */
function wrapCaption(text: string): string {
	const lines = packLines(text, CAPTION_LINE_CHARS);
	if (lines.length > CAPTION_MAX_LINES) {
		throw new Error(`caption does not fit ${CAPTION_MAX_LINES} lines, so words would be lost: ${JSON.stringify(text)}`);
	}
	return lines.map(escapeAss).join('\\N');
}

/**
 * Neutralizes the three characters ASS treats as markup.
 *
 * Narration is generated text — a release note containing `{` would otherwise
 * be read as an override block and silently swallow the rest of the line.
 */
function escapeAss(text: string): string {
	return text.replace(/\\/g, '∖').replace(/\{/g, '(').replace(/\}/g, ')');
}

function renderAss(cues: readonly Cue[], manifest: Manifest, config: Config): string {
	const { width, height } = manifest.project;
	const { fontName, fontSize, marginV } = config.subtitles;

	const header = [
		'[Script Info]',
		'ScriptType: v4.00+',
		`Title: ${manifest.project.title}`,
		'WrapStyle: 2',
		'ScaledBorderAndShadow: yes',
		`PlayResX: ${width}`,
		`PlayResY: ${height}`,
		'',
		'[V4+ Styles]',
		'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
		// BorderStyle 3 draws an opaque box behind the text, which is what keeps
		// captions readable over a screenshot of arbitrary brightness.
		`Style: Narration,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&HA0000000,0,0,0,0,100,100,0,0,3,2,0,2,120,120,${marginV},1`,
		// Title: bold, larger, pinned to the top-left (alignment 7) so it sits
		// over the panel chrome rather than over the content being shown.
		`Style: Title,${fontName},${Math.round(fontSize * 1.35)},&H00FFFFFF,&H00FFFFFF,&H00202020,&HB4101010,-1,0,0,0,100,100,0,0,3,3,0,7,90,90,70,1`,
		'',
		'[Events]',
		'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
	];

	const events = cues
		.filter((cue) => cue.end > cue.start)
		.map((cue) => {
			const style = cue.style ?? 'Narration';
			// Titles sit on a higher layer so a long caption can never be drawn
			// over the top of one.
			const layer = style === 'Title' ? 1 : 0;
			return `Dialogue: ${layer},${assTime(cue.start)},${assTime(cue.end)},${style},,0,0,0,,${cue.text}`;
		});

	return `${[...header, ...events].join('\n')}\n`;
}
