import { escapeHtml } from './formatUtils';
import { localize } from './localization';

export type SocialPlatform = 'linkedin' | 'bluesky' | 'mastodon';

// `cls` is spelled out (not built from `platform`) so the desktop app's hidden-control contract can find it.
const PLATFORMS: ReadonlyArray<{ platform: SocialPlatform; icon: string; cls: string }> = [
	{ platform: 'linkedin', icon: '💼', cls: 'share-btn-linkedin' },
	{ platform: 'bluesky', icon: '🦋', cls: 'share-btn-bluesky' },
	{ platform: 'mastodon', icon: '🐘', cls: 'share-btn-mastodon' },
];

/**
 * LinkedIn / Bluesky / Mastodon share buttons. Each button is `<idPrefix>-<platform>`, so one panel can
 * host several rows (the score and the toolbox card) without clashing ids.
 */
export function socialShareButtonsHtml(idPrefix: string): string {
	return PLATFORMS.map(({ platform, icon, cls }) =>
		`<button id="${idPrefix}-${platform}" class="share-btn ${cls}"><span class="share-btn-icon">${icon}</span><span>${escapeHtml(localize(`share.${platform}`))}</span></button>`
	).join('\n      ');
}

/** Wires the buttons rendered by {@link socialShareButtonsHtml} for the same `idPrefix`. */
export function wireSocialShareButtons(idPrefix: string, onShare: (platform: SocialPlatform) => void): void {
	for (const { platform } of PLATFORMS) {
		document.getElementById(`${idPrefix}-${platform}`)?.addEventListener('click', () => { onShare(platform); });
	}
}
