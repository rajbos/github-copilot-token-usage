import { escapeHtml } from './formatUtils';
import { localize } from './localization';

export type SocialPlatform = 'linkedin' | 'bluesky' | 'mastodon';

const PLATFORMS: ReadonlyArray<{ platform: SocialPlatform; icon: string }> = [
	{ platform: 'linkedin', icon: '💼' },
	{ platform: 'bluesky', icon: '🦋' },
	{ platform: 'mastodon', icon: '🐘' },
];

/**
 * LinkedIn / Bluesky / Mastodon share buttons. Each button is `<idPrefix>-<platform>`, so one panel can
 * host several rows (the score and the toolbox card) without clashing ids.
 */
export function socialShareButtonsHtml(idPrefix: string): string {
	return PLATFORMS.map(({ platform, icon }) =>
		`<button id="${idPrefix}-${platform}" class="share-btn share-btn-${platform}"><span class="share-btn-icon">${icon}</span><span>${escapeHtml(localize(`share.${platform}`))}</span></button>`
	).join('\n      ');
}

/** Wires the buttons rendered by {@link socialShareButtonsHtml} for the same `idPrefix`. */
export function wireSocialShareButtons(idPrefix: string, onShare: (platform: SocialPlatform) => void): void {
	for (const { platform } of PLATFORMS) {
		document.getElementById(`${idPrefix}-${platform}`)?.addEventListener('click', () => { onShare(platform); });
	}
}
