/**
 * `doctor` — check the machine before a render, not during one.
 *
 * Every dependency here fails late and confusingly if you find out about it
 * mid-pipeline: an FFmpeg build without libass burns no subtitles and says
 * nothing useful, a missing NVENC encoder fails after all the narration has
 * been generated, and an unbuilt extension produces screenshots of nothing.
 *
 * Nothing here is fatal on its own — the report says what works, what does not
 * and what each missing piece costs you, so you can start with the three
 * things you already have installed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Config } from './config';
import { isRunnable, log, PROJECT_ROOT, REPO_ROOT, resolveExecutable, resolveInProject, run } from './util';

interface Check {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
	/** What you lose without it. Empty when it is required. */
	readonly optional?: string;
}

export async function doctor(config: Config): Promise<boolean> {
	const checks: Check[] = [];
	const push = (check: Check) => checks.push(check);

	/* ---- FFmpeg ---- */

	const ffmpegOk = await isRunnable(config.tools.ffmpeg, ['-version']);
	push({ name: 'ffmpeg', ok: ffmpegOk, detail: ffmpegOk ? await firstLine(config.tools.ffmpeg) : `not runnable as "${config.tools.ffmpeg}"` });

	if (ffmpegOk) {
		const encoders = await capture(config.tools.ffmpeg, ['-hide_banner', '-encoders']);
		const filters = await capture(config.tools.ffmpeg, ['-hide_banner', '-filters']);

		// The *configured* encoder is required, even though a CPU fallback
		// exists. Nothing selects that fallback automatically, so marking this
		// optional let `doctor` print "Ready to render" for a build that was
		// then guaranteed to fail. The fallback belongs in the remediation
		// text, not in the pass/fail decision.
		const hasEncoder = encoders.includes(config.encode.encoder);
		const cpuHint = config.encode.encoder.includes('nvenc')
			? ' — set encode.encoder to libx264 to render on the CPU instead'
			: '';
		push({
			name: `encoder ${config.encode.encoder}`,
			ok: hasEncoder,
			detail: hasEncoder ? 'available' : `this build has no ${config.encode.encoder}${cpuHint}`,
		});

		// `concat` joins scenes across a hard cut, so it is as load-bearing as
		// xfade whenever a manifest contains a "none" transition.
		for (const filter of ['zoompan', 'xfade', 'concat', 'subtitles', 'loudnorm', 'amix', 'adelay']) {
			const has = new RegExp(`\\b${filter}\\b`).test(filters);
			// Subtitles are only genuinely optional when they are switched off.
			// With `subtitles.enabled` true, a build without libass fails during
			// render, so reporting it as a soft warning would be wrong.
			const subtitlesOptional = filter === 'subtitles' && !config.subtitles.enabled;
			push({
				name: `filter ${filter}`,
				ok: has,
				detail: has
					? 'available'
					: filter === 'subtitles' && config.subtitles.enabled
						? 'missing from this FFmpeg build — captions and titles are enabled, so the render will fail'
						: 'missing from this FFmpeg build',
				...(subtitlesOptional ? { optional: 'subtitles are disabled, so this is not needed' } : {}),
			});
		}
	}

	push({ name: 'ffprobe', ok: await isRunnable(config.tools.ffprobe, ['-version']), detail: config.tools.ffprobe });

	/* ---- The screenshot harness ---- */

	const webviewDist = path.join(REPO_ROOT, 'vscode-extension', 'dist', 'webview');
	const built = fs.existsSync(webviewDist);
	push({
		name: 'webview bundles',
		ok: built,
		detail: built
			? `${fs.readdirSync(webviewDist).filter((f) => f.endsWith('.js')).length} bundle(s) in dist/webview`
			: 'not built — run: cd vscode-extension && npm run compile',
	});

	let playwrightOk = false;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { loadChromium } = require(path.join(REPO_ROOT, '.github', 'skills', 'visual-view-diff', 'lib', 'browser.js')) as { loadChromium(): unknown };
		loadChromium();
		playwrightOk = true;
	} catch (error) {
		push({ name: 'playwright chromium', ok: false, detail: (error as Error).message.split('\n')[0] ?? 'unavailable' });
	}
	if (playwrightOk) {
		push({ name: 'playwright chromium', ok: true, detail: 'available via the visual-view-diff harness' });
	}

	/* ---- Voice ---- */

	switch (config.voice.engine) {
		case 'mistral': {
			const mistral = config.voice.mistral;
			const hasKey = Boolean(process.env[mistral.apiKeyEnv]);
			push({
				name: `mistral api key (${mistral.apiKeyEnv})`,
				ok: hasKey,
				// Length only. Never the key.
				detail: hasKey
					? `set, ${String(process.env[mistral.apiKeyEnv] ?? '').length} characters`
					: `not set — export ${mistral.apiKeyEnv} before rendering`,
			});
			push({
				name: 'mistral voice',
				ok: Boolean(mistral.voiceId),
				detail: mistral.voiceId ? `${mistral.model}, voice ${mistral.voiceId}` : 'voice.mistral.voiceId is empty',
			});
			push({
				name: 'network',
				ok: true,
				detail: 'this engine sends narration text to api.mistral.ai and is billed per request',
			});
			break;
		}
		case 'voicebox': {
			const reachable = await ping(config.voice.voicebox.endpoint);
			push({
				name: 'voicebox server',
				ok: reachable,
				detail: reachable ? `responding at ${config.voice.voicebox.endpoint}` : `nothing answering at ${config.voice.voicebox.endpoint} — start Voicebox first`,
			});
			const reference = safeResolve(config.voice.voicebox.referenceWav);
			push({
				name: 'voice reference',
				ok: reference !== null,
				detail: reference ? path.relative(REPO_ROOT, reference) : `${config.voice.voicebox.referenceWav} not found — see assets/voice/README.md`,
			});
			break;
		}
		case 'sapi': {
			const script = path.join(PROJECT_ROOT, 'scripts', 'sapi-speak.ps1');
			const ok = fs.existsSync(script);
			push({ name: 'sapi script', ok, detail: ok ? 'present' : `missing at ${script}` });
			const voices = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ListVoices']);
			const count = voices.split('\n').filter((line) => /^[A-Za-z].*\s{2,}/.test(line.trim())).length;
			push({ name: 'sapi voices', ok: count > 0, detail: count > 0 ? `${Math.max(0, count - 1)} installed` : 'none found' });
			break;
		}
		case 'command': {
			const raw = config.voice.command.argv[0];
			// Resolved exactly the way the adapter resolves it, so this reports
			// on the command that will actually run rather than on a relative
			// name that happens to work from wherever doctor was started.
			let command: string | undefined;
			try {
				command = raw ? resolveExecutable(raw, 'voice.command.argv[0]') : undefined;
			} catch {
				command = undefined;
			}
			const ok = command ? await isRunnable(command, ['--help']) : false;
			push({ name: `tts command "${raw ?? '(unset)'}"`, ok, detail: ok ? 'runnable' : 'not runnable — check voice.command.argv' });
			break;
		}
		case 'silence':
			push({ name: 'voice engine', ok: true, detail: 'silence — no speech will be generated' });
			break;
	}

	/* ---- Optional extras ---- */

	if (config.llm.enabled) {
		const reachable = await ping(config.llm.endpoint);
		push({
			name: `llm ${config.llm.model}`,
			ok: reachable,
			detail: reachable ? `${config.llm.endpoint} responding` : `${config.llm.endpoint} unreachable`,
			optional: 'set llm.enabled to false to use the catalog-derived script as written',
		});
	}

	if (config.subtitles.align) {
		const command = config.subtitles.whisperCommand;
		const ok = await isRunnable(command, ['--help']);
		push({
			name: `aligner "${command}"`,
			ok,
			detail: ok ? 'runnable' : 'not installed',
			optional: 'captions fall back to a sentence-level split, still timed from the real audio',
		});
	}

	/* ---- Report ---- */

	log.group('Environment');
	let requiredFailures = 0;
	for (const check of checks) {
		const marker = check.ok ? '✓' : check.optional ? '!' : '✗';
		log.info(`${marker} ${check.name}: ${check.detail}`);
		if (!check.ok && check.optional) {
			log.info(`    → ${check.optional}`);
		}
		if (!check.ok && !check.optional) { requiredFailures += 1; }
	}
	log.info(requiredFailures === 0 ? 'Ready to render.' : `${requiredFailures} required dependency/dependencies missing.`);
	log.groupEnd();

	return requiredFailures === 0;
}

async function firstLine(command: string): Promise<string> {
	const text = await capture(command, ['-version']);
	return text.split('\n')[0]?.trim() ?? '';
}

async function capture(command: string, args: readonly string[]): Promise<string> {
	try {
		const { stdout, stderr } = await run(command, args, { check: false, timeoutMs: 60000 });
		return `${stdout}\n${stderr}`;
	} catch {
		return '';
	}
}

/** True when anything at all answers an HTTP request at `endpoint`. */
async function ping(endpoint: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 4000);
	try {
		await fetch(endpoint, { signal: controller.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

function safeResolve(candidate: string): string | null {
	try {
		const resolved = resolveInProject(candidate, 'voice reference');
		return fs.existsSync(resolved) ? resolved : null;
	} catch {
		return null;
	}
}
