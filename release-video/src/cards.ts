/**
 * The title and download cards, rendered as web pages.
 *
 * These are the two frames in the video that are not a screenshot: the logo
 * sting after the cold open, and the closing card with the repository URL and
 * the marketplaces the extension ships to.
 *
 * They are built as HTML and photographed by the same headless browser that
 * takes the screenshots, rather than assembled with FFmpeg's `drawtext`. That
 * buys real typography, real layout, and SVG logos that stay sharp — and it
 * avoids `drawtext`'s font-path escaping entirely. The cost is nothing: the
 * browser is already running for the screenshots.
 *
 * Images are inlined as data URIs. A `file://` page is not reliably allowed to
 * pull in `file://` sub-resources, and a card that silently renders without
 * its logo would pass every check this pipeline has.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { paths, type Config } from './config';
import { ensureDir, log, resolveInRepo } from './util';

/** Media types for the logo formats the repository actually ships. */
const MEDIA_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
};

function dataUri(repoRelativePath: string, label: string): string {
	const file = resolveInRepo(repoRelativePath, label);
	if (!fs.existsSync(file)) {
		throw new Error(`${label} not found at ${file}`);
	}
	const type = MEDIA_TYPES[path.extname(file).toLowerCase()];
	if (!type) {
		throw new Error(`${label} has an unsupported image type: ${path.extname(file)}`);
	}
	return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** Escapes text for HTML. Card text comes from config, but it still gets escaped. */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const BASE_CSS = `
	* { margin: 0; padding: 0; box-sizing: border-box; }
	html, body { width: 100%; height: 100%; }
	body {
		/* Matches the pad colour the renderer uses, so a card cross-fading into
		   a screenshot does not flash a different black. */
		background: radial-gradient(ellipse at 50% 40%, #2b2b2e 0%, #1e1e1e 70%);
		color: #f3f3f3;
		font-family: "Segoe UI", "Segoe UI Variable", system-ui, sans-serif;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}
	.card { text-align: center; }
`;

/** The logo sting shown after the cold open. */
function titleCardHtml(config: Config, version: string): string {
	const logo = dataUri(config.branding.logo, 'branding.logo');
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_CSS}
	.logo { width: 42vw; filter: drop-shadow(0 12px 40px rgba(0,0,0,0.55)); }
	.version {
		margin-top: 48px;
		font-size: 44px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: #9bd1ff;
	}
	</style></head><body><div class="card">
		<img class="logo" src="${logo}" alt="">
		<div class="version">Version ${escapeHtml(version)}</div>
	</div></body></html>`;
}

/** The closing card: where to get it. */
function downloadCardHtml(config: Config): string {
	const logo = dataUri(config.branding.logo, 'branding.logo');

	const tiles = config.branding.marketplaces.map((market) => {
		const icon = dataUri(market.logo, `marketplace logo for ${market.name}`);
		return `<div class="tile">
			<div class="tile-icon"><img src="${icon}" alt=""></div>
			<div class="tile-name">${escapeHtml(market.name)}</div>
		</div>`;
	}).join('');

	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_CSS}
	.card { width: 92vw; }
	.logo { width: 20vw; margin-bottom: 44px; }
	.tagline {
		font-size: 46px;
		font-weight: 600;
		margin-bottom: 52px;
		color: #ffffff;
	}
	.tiles { display: flex; justify-content: center; gap: 40px; margin-bottom: 64px; }
	.tile {
		width: 300px;
		padding: 34px 20px;
		border-radius: 18px;
		background: rgba(255,255,255,0.055);
		border: 1px solid rgba(255,255,255,0.12);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 22px;
	}
	/* A white plate behind each logo: several of these are dark-on-transparent
	   and would vanish into the card background. */
	.tile-icon {
		width: 104px; height: 104px;
		border-radius: 16px;
		background: #ffffff;
		display: flex; align-items: center; justify-content: center;
	}
	.tile-icon img { width: 68px; height: 68px; object-fit: contain; }
	.tile-name { font-size: 25px; font-weight: 600; line-height: 1.3; }
	.repo {
		font-family: "Cascadia Code", Consolas, "Courier New", monospace;
		font-size: 40px;
		color: #9bd1ff;
		padding: 20px 46px;
		border-radius: 14px;
		background: rgba(155,209,255,0.09);
		display: inline-block;
	}
	</style></head><body><div class="card">
		<img class="logo" src="${logo}" alt="">
		<div class="tagline">${escapeHtml(config.branding.tagline)}</div>
		<div class="tiles">${tiles}</div>
		<div class="repo">${escapeHtml(config.branding.repoUrl)}</div>
	</div></body></html>`;
}

export interface CardSpec {
	readonly id: string;
	readonly html: string;
}

export function cardSpecs(config: Config, version: string): CardSpec[] {
	return [
		{ id: 'title', html: titleCardHtml(config, version) },
		{ id: 'download', html: downloadCardHtml(config) },
	];
}

/** Project-relative path of a card's PNG, as it appears in the manifest. */
export function cardRelativePath(id: string): string {
	return `assets/cards/${id}.png`;
}

/**
 * Renders the cards to PNG using an already-open browser.
 *
 * Takes the browser rather than launching one so the screenshot stage can do
 * both in a single Chromium process.
 */
export async function renderCards(
	browser: any,
	config: Config,
	version: string,
	size: { width: number; height: number },
): Promise<void> {
	ensureDir(paths.cards);
	const pageDir = ensureDir(path.join(paths.cache, 'pages'));

	for (const card of cardSpecs(config, version)) {
		const context = await browser.newContext({
			viewport: { width: size.width, height: size.height },
			deviceScaleFactor: 1,
			colorScheme: 'dark',
			reducedMotion: 'reduce',
		});
		const page = await context.newPage();
		try {
			const pageFile = path.join(pageDir, `card-${card.id}.html`);
			fs.writeFileSync(pageFile, card.html, 'utf8');
			await page.goto(`file:///${pageFile.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 30000 });
			// Let the fonts settle; a card captured mid-swap renders in a fallback.
			await page.waitForTimeout(400);

			const outFile = path.join(paths.cards, `${card.id}.png`);
			await page.screenshot({ path: outFile, fullPage: false });
			log.info(`card ${card.id} → ${path.relative(process.cwd(), outFile)}`);
		} finally {
			await context.close();
		}
	}
}
