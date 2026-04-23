/**
 * Upload service for the self-hosted sharing server.
 * Sends daily rollup data to a configured endpoint using a GitHub Bearer token.
 */

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
}

/** Maximum number of entries per HTTP request (matches server-side limit). */
const BATCH_SIZE = 500;

export class SharingServerUploadService {
	async uploadRollups(
		endpointUrl: string,
		githubToken: string,
		entries: SharingServerEntry[],
		log: (msg: string) => void,
		warn: (msg: string) => void,
	): Promise<{ success: boolean; entriesUploaded: number; message: string }> {
		const baseUrl = endpointUrl.replace(/\/$/, '');
		const url = `${baseUrl}/api/upload`;

		try {
			let totalUploaded = 0;
			for (let i = 0; i < entries.length; i += BATCH_SIZE) {
				const batch = entries.slice(i, i + BATCH_SIZE);
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

				// Read actual uploaded count — server may reject entries that fail validation
				let serverUploaded = batch.length;
				try {
					const result = await response.json() as { uploaded?: number; errors?: string[] };
					if (typeof result.uploaded === 'number') { serverUploaded = result.uploaded; }
					if (result.errors && result.errors.length > 0) {
						warn(`Sharing server upload: server rejected ${batch.length - serverUploaded} entries: ${result.errors.slice(0, 3).join('; ')}`);
					}
				} catch { /* response not JSON, use batch.length */ }
				totalUploaded += serverUploaded;
			}

			const message = `Uploaded ${totalUploaded} entries`;
			log(`Sharing server upload: ${message}`);
			return { success: true, entriesUploaded: totalUploaded, message };
		} catch (e: any) {
			const message = `Upload failed: ${e?.message ?? e}`;
			warn(`Sharing server upload: ${message}`);
			return { success: false, entriesUploaded: 0, message };
		}
	}
}
