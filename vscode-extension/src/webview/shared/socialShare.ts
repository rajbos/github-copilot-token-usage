export type SocialPlatform = 'linkedin' | 'bluesky' | 'mastodon';

/**
 * LinkedIn / Bluesky / Mastodon share buttons. Each button is `<idPrefix>-<platform>`, so one panel can
 * host several rows (the score and the toolbox card) without clashing ids.
 */
export function socialShareButtonsHtml(idPrefix: string): string {
	return `
      <button id="${idPrefix}-linkedin" class="share-btn share-btn-linkedin"><span class="share-btn-icon">💼</span><span>Share on LinkedIn</span></button>
      <button id="${idPrefix}-bluesky" class="share-btn share-btn-bluesky"><span class="share-btn-icon">🦋</span><span>Share on Bluesky</span></button>
      <button id="${idPrefix}-mastodon" class="share-btn share-btn-mastodon"><span class="share-btn-icon">🐘</span><span>Share on Mastodon</span></button>`;
}

/** Wires the buttons rendered by {@link socialShareButtonsHtml} for the same `idPrefix`. */
export function wireSocialShareButtons(idPrefix: string, onShare: (platform: SocialPlatform) => void): void {
	for (const platform of ['linkedin', 'bluesky', 'mastodon'] as const) {
		document.getElementById(`${idPrefix}-${platform}`)?.addEventListener('click', () => { onShare(platform); });
	}
}
