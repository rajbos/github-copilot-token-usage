/**
 * Upload service for the self-hosted sharing server.
 * Sends daily rollup data to a configured endpoint using a GitHub Bearer token.
 */

import { safeStringifyError } from '../../../../src/utils/errors';

export interface SharingServerEntry {
	day: string;
	model: string;
	workspaceId: string;
	workspaceName?: string;
	machineId: string;
	machineName?: string;
	editor?: string;
	inputTokens: number;
	outputTokens: number;
	interactions: number;
	datasetId?: string;
	fluencyMetrics?: Record<string, unknown>;
}

/** Maximum number of entries per HTTP request (matches server-side limit). */
const BATCH_SIZE = 500;

/**
 * Packs entries into requests of at most `maxPerRequest` without ever splitting one
 * (dataset, day) across requests. The server replaces a user's rows for every day in a request
 * (delete, then insert), so a day spread over two requests would lose the first request's rows.
 * A single day larger than the limit cannot be sent atomically and is returned in `oversized`.
 */
export function packEntriesByDay<T extends { day: string; datasetId?: string }>(entries: T[], maxPerRequest: number): { batches: T[][]; oversized: Array<{ day: string; datasetId: string; count: number }> } {
	const byDay = new Map<string, T[]>();
	for (const entry of entries) {
		const key = `${entry.datasetId ?? 'default'}\u0000${entry.day}`;
		const group = byDay.get(key);
		if (group) { group.push(entry); } else { byDay.set(key, [entry]); }
	}
	const batches: T[][] = [];
	const oversized: Array<{ day: string; datasetId: string; count: number }> = [];
	let current: T[] = [];
	for (const group of byDay.values()) {
		if (group.length > maxPerRequest) {
			oversized.push({ day: group[0].day, datasetId: group[0].datasetId ?? 'default', count: group.length });
			continue;
		}
		if (current.length + group.length > maxPerRequest) {
			batches.push(current);
			current = [];
		}
		current.push(...group);
	}
	if (current.length > 0) { batches.push(current); }
	return { batches, oversized };
}

export class SharingServerUploadService {
	/**
	 * How many entries of a batch the server confirmed it stored.
	 *
	 * Only a parsed `uploaded` number counts as evidence of delivery, and only
	 * when it is a whole number of entries the batch could actually contain. A
	 * 2xx whose body will not parse, carries no `uploaded` count, or reports a
	 * nonsensical one is what a proxy or a misconfigured endpoint returns, so it
	 * contributes nothing and is recorded in `serverErrors`.
	 */
	private async readStoredCount(
		response: Response,
		batchSize: number,
		warn: (msg: string) => void,
		serverErrors: string[],
	): Promise<number> {
		let result: { uploaded?: number; errors?: string[] };
		try {
			result = await response.json() as { uploaded?: number; errors?: string[] };
		} catch {
			warn(`Sharing server upload: ${response.status} response is not JSON — treating the batch as not stored`);
			serverErrors.push(`Unparseable ${response.status} response`);
			return 0;
		}
		if (result.errors && result.errors.length > 0) {
			warn(`Sharing server upload: server rejected ${batchSize - (result.uploaded ?? 0)} entries: ${result.errors.slice(0, 3).join('; ')}`);
			serverErrors.push(...result.errors);
		}
		if (typeof result.uploaded !== 'number') {
			warn(`Sharing server upload: ${response.status} response has no "uploaded" count — treating the batch as not stored`);
			serverErrors.push(`${response.status} response without an "uploaded" count`);
			return 0;
		}
		// A count that is fractional, negative, or larger than what we sent cannot
		// have come from the real endpoint counting stored rows, so it is not
		// evidence of anything — and an inflated one would otherwise be clamped up
		// to a full successful batch.
		if (!Number.isInteger(result.uploaded) || result.uploaded < 0 || result.uploaded > batchSize) {
			warn(`Sharing server upload: ${response.status} response reported an impossible "uploaded" count ${result.uploaded} for a batch of ${batchSize} — treating the batch as not stored`);
			serverErrors.push(`Invalid "uploaded" count ${result.uploaded} for a batch of ${batchSize}`);
			return 0;
		}
		return result.uploaded;
	}

	/**
	 * Upload daily rollup entries in batches.
	 *
	 * `success` means every entry was reported stored by the server. It is not a
	 * synonym for "got a 2xx": the upload endpoint returns HTTP 200 with
	 * `uploaded: 0` plus an `errors` array when entries fail validation or a
	 * dataset transaction rolls back, and a proxy or misconfigured endpoint can
	 * answer 200 with a body that is not an upload result at all. Only a parsed
	 * `uploaded` count is treated as evidence of delivery. Errors are reported
	 * through `warn` rather than thrown, so callers must check this result.
	 */
	async uploadRollups(
		endpointUrl: string,
		githubToken: string,
		entries: SharingServerEntry[],
		log: (msg: string) => void,
		warn: (msg: string) => void,
	): Promise<{ success: boolean; entriesUploaded: number; message: string }> {
		const baseUrl = endpointUrl.replace(/\/$/, '');
		const url = `${baseUrl}/api/upload`;

		const { batches, oversized } = packEntriesByDay(entries, BATCH_SIZE);
		for (const o of oversized) {
			warn(`Sharing server upload: skipping ${o.day} (${o.count} entries exceeds the ${BATCH_SIZE}-entry request limit; uploading it in parts would overwrite itself)`);
		}

		try {
			let totalUploaded = 0;
			const serverErrors: string[] = [];
			for (const batch of batches) {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${githubToken}`,
					},
					body: JSON.stringify(batch),
				});

				if (!response.ok) {
					const errorText = await response.text().catch(() => '');
					const message = `HTTP ${response.status}: ${errorText}`;
					warn(`Sharing server upload: ${message}`);
					return { success: false, entriesUploaded: totalUploaded, message };
				}

				// Read the actual stored count — a 2xx alone is not evidence of
				// delivery, so only a parsed `uploaded` number counts.
				totalUploaded += await this.readStoredCount(response, batch.length, warn, serverErrors);
			}

			// A 2xx response does not mean the data was stored. The server answers
			// HTTP 200 with `uploaded: 0` and an `errors` array when entries fail
			// validation or a dataset transaction rolls back, so anything short of
			// every entry landing has to be reported as a failed upload — otherwise
			// callers advance the "Last Sync" marker for data that never arrived.
			// The denominator is what was actually attempted: entries belonging to
			// an oversized day were never sent, and are reported separately below.
			const attempted = batches.reduce((total, batch) => total + batch.length, 0);
			const stored = Math.min(totalUploaded, attempted);
			if (stored < attempted || serverErrors.length > 0) {
				const detail = serverErrors.length > 0 ? `: ${serverErrors.slice(0, 3).join('; ')}` : '';
				const message = `Server stored ${stored} of ${attempted} entries${detail}`;
				warn(`Sharing server upload: ${message}`);
				return { success: false, entriesUploaded: stored, message };
			}

			if (oversized.length > 0) {
				const message = `Uploaded ${totalUploaded} entries; skipped ${oversized.length} day(s) over the ${BATCH_SIZE}-entry request limit: ${oversized.map(o => o.day).join(', ')}`;
				warn(`Sharing server upload: ${message}`);
				return { success: false, entriesUploaded: totalUploaded, message };
			}
			const message = `Uploaded ${totalUploaded} entries`;
			log(`Sharing server upload: ${message}`);
			return { success: true, entriesUploaded: totalUploaded, message };
		} catch (e: unknown) {
			const message = `Upload failed: ${safeStringifyError(e)}`;
			warn(`Sharing server upload: ${message}`);
			return { success: false, entriesUploaded: 0, message };
		}
	}

	/**
	 * Upload the extension's locally-computed fluency score so the server dashboard
	 * shows the exact same result as the extension's AI Fluency Score panel.
	 *
	 * Returns whether the score actually reached the server. A 2xx alone is not
	 * enough — the endpoint answers `{ ok: true }`, and anything else behind a 200
	 * (a proxy's HTML, unrelated JSON) is not evidence the score was stored.
	 * Failures are reported through `warn` rather than thrown, so a caller cannot
	 * use try/catch to tell success from failure and must check this value.
	 */
	async uploadFluencyScore(
		endpointUrl: string,
		githubToken: string,
		score: Record<string, unknown>,
		log: (msg: string) => void,
		warn: (msg: string) => void,
	): Promise<boolean> {
		const baseUrl = endpointUrl.replace(/\/$/, '');
		const url = `${baseUrl}/api/fluency-score`;
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${githubToken}`,
				},
				body: JSON.stringify(score),
			});
			if (!response.ok) {
				const errorText = await response.text().catch(() => '');
				warn(`Sharing server fluency-score upload: HTTP ${response.status}: ${errorText}`);
				return false;
			}
			let body: { ok?: unknown };
			try {
				body = await response.json() as { ok?: unknown };
			} catch {
				warn(`Sharing server fluency-score upload: ${response.status} response is not JSON — treating the score as not stored`);
				return false;
			}
			if (body?.ok !== true) {
				warn(`Sharing server fluency-score upload: ${response.status} response did not confirm the score was stored — treating it as not stored`);
				return false;
			}
			log('Sharing server fluency-score upload: ok');
			return true;
		} catch (e: unknown) {
			warn(`Sharing server fluency-score upload failed: ${safeStringifyError(e)}`);
			return false;
		}
	}
}
