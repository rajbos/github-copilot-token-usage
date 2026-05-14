/**
 * `segment` command - Output a compact token usage string for oh-my-posh.
 *
 * Maintains its own short-lived file cache (~/.copilot-token-tracker/omp-segment-cache.json)
 * so that repeated prompt renders return immediately without re-parsing session files.
 * The session file cache (cli-cache.json) is loaded automatically via the preAction hook
 * in cli.ts, so a cache miss here still benefits from the parsed-session cache.
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { discoverSessionFiles, calculateDetailedStats, formatTokens } from '../helpers';

const SEGMENT_CACHE_DIR = path.join(os.homedir(), '.copilot-token-tracker');
const SEGMENT_CACHE_PATH = path.join(SEGMENT_CACHE_DIR, 'omp-segment-cache.json');
const DEFAULT_TTL_MINUTES = 15;

interface SegmentCacheFile {
	updatedAt: string;
	formatted: string;
	todayTokens: number;
	last30DaysTokens: number;
}

/** Read the segment output cache. Returns null on miss, expiry, or corrupt data. */
function readSegmentCache(ttlMinutes: number): SegmentCacheFile | null {
	try {
		if (!fs.existsSync(SEGMENT_CACHE_PATH)) { return null; }
		const data: SegmentCacheFile = JSON.parse(fs.readFileSync(SEGMENT_CACHE_PATH, 'utf-8'));

		// Validate shape before trusting any values
		if (
			typeof data.formatted !== 'string' ||
			typeof data.updatedAt !== 'string' ||
			typeof data.todayTokens !== 'number' ||
			typeof data.last30DaysTokens !== 'number'
		) {
			return null;
		}

		const updatedMs = Date.parse(data.updatedAt);
		if (!Number.isFinite(updatedMs)) { return null; }

		const ageMs = Date.now() - updatedMs;
		// Reject negative ages (clock skew) and expired entries
		if (ageMs < 0 || ageMs > ttlMinutes * 60_000) { return null; }

		return data;
	} catch {
		return null;
	}
}

/** Persist the segment output to the cache file. Best-effort — never throws. */
function writeSegmentCache(entry: SegmentCacheFile): void {
	try {
		fs.mkdirSync(SEGMENT_CACHE_DIR, { recursive: true });
		fs.writeFileSync(SEGMENT_CACHE_PATH, JSON.stringify(entry), 'utf-8');
	} catch {
		// Best-effort: cache write failures must not crash the prompt
	}
}

export const segmentCommand = new Command('segment')
	.description('Output a compact token usage string for use in oh-my-posh prompt segments')
	.option('--ttl <minutes>', `Segment cache TTL in minutes (default: ${DEFAULT_TTL_MINUTES})`, `${DEFAULT_TTL_MINUTES}`)
	.option('--refresh', 'Force refresh — bypass the segment output cache')
	.option('--hide-zero', 'Output nothing when both today and 30-day token counts are zero')
	.action(async (options) => {
		const parsedTtl = Number(options.ttl);
		const ttl = Number.isFinite(parsedTtl) && parsedTtl >= 0 ? parsedTtl : DEFAULT_TTL_MINUTES;

		// Fast path: serve from the segment output cache when still fresh
		if (!options.refresh) {
			const cached = readSegmentCache(ttl);
			if (cached) {
				if (options.hideZero && cached.todayTokens === 0 && cached.last30DaysTokens === 0) {
					return;
				}
				process.stdout.write(cached.formatted);
				return;
			}
		}

		// Cache miss — discover files and compute stats
		// (The preAction hook in cli.ts has already loaded the session file cache)
		const files = await discoverSessionFiles();
		let todayTokens = 0;
		let last30DaysTokens = 0;

		if (files.length > 0) {
			const stats = await calculateDetailedStats(files);
			todayTokens = stats.today.tokens;
			last30DaysTokens = stats.last30Days.tokens;
		}

		if (options.hideZero && todayTokens === 0 && last30DaysTokens === 0) {
			writeSegmentCache({
				updatedAt: new Date().toISOString(),
				formatted: '',
				todayTokens,
				last30DaysTokens,
			});
			return;
		}

		const formatted = `${formatTokens(todayTokens)} today · ${formatTokens(last30DaysTokens)} 30d`;

		writeSegmentCache({
			updatedAt: new Date().toISOString(),
			formatted,
			todayTokens,
			last30DaysTokens,
		});

		process.stdout.write(formatted);
	});
