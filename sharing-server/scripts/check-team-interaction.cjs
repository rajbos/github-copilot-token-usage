'use strict';

// Uses the existing headless harness with a temporary loopback server and isolated data.
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { loadChromium } = require('../../.github/skills/visual-view-diff/lib/browser.js');

async function main() {
	const chromium = loadChromium();
	const root = path.resolve(__dirname, '..');
	const scratch = mkdtempSync(path.join(tmpdir(), 'team-interactions-'));
	let browser;
	let server;
	let closeDb;
	try {
		process.env.LOCAL_DATA_DIR = scratch;
		process.env.SESSION_SECRET = 'headless-fixture-session-key-not-a-real-secret';
		process.env.CHART_JS_PATH = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
		delete process.env.ADMIN_GITHUB_LOGINS;
		const bundle = path.join(scratch, 'fixture.cjs');
		buildSync({
			stdin: {
				contents: `
					export { createApp } from './src/app.ts';
					export { getDb, upsertUser, upsertUpload, closeDb } from './src/db.ts';
					export { encodeSession, makeClaims, COOKIE_NAME } from './src/session.ts';
					export { serve } from '@hono/node-server';
				`,
				resolveDir: root, loader: 'ts',
			},
			bundle: true, platform: 'node', format: 'cjs', target: 'node22',
			external: ['node:sqlite'], outfile: bundle, logLevel: 'silent',
		});
		const fixture = require(bundle);
		closeDb = fixture.closeDb;
		const app = fixture.createApp({ imagesDir: path.join(root, 'images') });
		const address = await new Promise(resolve => {
			server = fixture.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, resolve);
		});
		const baseUrl = `http://127.0.0.1:${address.port}`;
		assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
		const today = new Date().toISOString().slice(0, 10);
		const old = new Date();
		old.setUTCDate(old.getUTCDate() - 40);
		const viewer = fixture.upsertUser(78001, 'self-login', 'Your profile', null);
		const forbidden = ['PRIVATE_PEER_LOGIN', 'PRIVATE_PEER_NAME', 'PRIVATE_WORKSPACE', 'PRIVATE_MACHINE', 'PRIVATE_MODEL'];
		for (let i = 0; i < 4; i++) {
			const user = i === 0 ? viewer : fixture.upsertUser(78001 + i, forbidden[0] + i, forbidden[1] + i, null);
			fixture.upsertUpload(user.id, {
				day: today, workspaceId: forbidden[2], machineId: forbidden[3], model: forbidden[4],
				inputTokens: (i + 1) * 100, outputTokens: 0, interactions: i + 1,
			});
			if (i === 0) fixture.upsertUpload(user.id, {
				day: old.toISOString().slice(0, 10), workspaceId: 'own-old', machineId: 'own-old', model: 'own-old',
				inputTokens: 1000, outputTokens: 0, interactions: 10,
			});
		}
		const assertPrivate = text => {
			for (const value of forbidden) assert.ok(!text.includes(value), `leaked ${value}`);
		};
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
		await context.addCookies([{
			name: fixture.COOKIE_NAME, value: fixture.encodeSession(fixture.makeClaims(viewer.id)),
			url: baseUrl, httpOnly: true, sameSite: 'Lax',
		}]);
		await context.route('**/*', async route => {
			assert.equal(new URL(route.request().url()).origin, baseUrl, 'no external network requests allowed');
			await route.continue();
		});
		const page = await context.newPage();
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`${baseUrl}/team`);
		assert.equal(await page.locator('#team-member-table tbody tr').count(), 4);
		assertPrivate(await page.content());
		assert.equal(await page.locator('.team-self td').first().textContent(), '4');

		for (const days of [7, 90, 30]) {
			await page.getByRole('link', { name: `Last ${days} days`, exact: true }).click();
			await page.waitForURL(`**/team?days=${days}`);
			assert.equal(await page.locator('#team-daily-numbers tbody tr').count(), days);
			assert.equal(await page.locator('.team-self td').first().textContent(), days === 90 ? '1' : '4');
			assertPrivate(await page.content());
		}
		await page.getByRole('button', { name: 'Per-user average', exact: true }).click();
		assert.equal(await page.getByRole('button', { name: 'Per-user average', exact: true }).getAttribute('aria-pressed'), 'true');
		let chart = await page.evaluate(() => {
			const chart = Chart.getChart(document.getElementById('team-trend-chart'));
			return { label: chart.data.datasets[0].label, last: chart.data.datasets[0].data.at(-1), own: chart.data.datasets[1].data.at(-1) };
		});
		assert.deepEqual(chart, { label: 'Mean per daily active uploader', last: 250, own: 100 });
		await page.getByRole('button', { name: 'Team total', exact: true }).click();
		assert.equal(await page.evaluate(() => Chart.getChart(document.getElementById('team-trend-chart')).data.datasets[0].data.at(-1)), 1000);
		await page.locator('#team-daily-numbers summary').click();
		assert.equal(await page.locator('#team-daily-numbers').getAttribute('open'), '');
		for (const format of ['CSV', 'JSON']) {
			const downloadPromise = page.waitForEvent('download');
			await page.getByRole('link', { name: `Download ${format}`, exact: true }).click();
			const download = await downloadPromise;
			assert.equal(download.suggestedFilename(), `team-insights-30days.${format.toLowerCase()}`);
			const contents = readFileSync(await download.path(), 'utf8');
			assertPrivate(contents);
			if (format === 'JSON') {
				const data = JSON.parse(contents);
				assert.equal(data.self.totalTokens, 100);
				assert.equal(data.summary.totalTokens, 1000);
			} else {
				assert.ok(contents.includes('"You","4","100","0","100"'));
			}
		}
		// A page wider than a phone screen is a layout bug: only tables scroll sideways, inside their card.
		const assertFitsPhone = async label => {
			// Charts resize a frame after the viewport does, so wait for the layout to settle before judging it.
			await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth, null, { timeout: 5000 }).catch(() => {});
			const overflow = await page.evaluate(() => {
				const widest = [...document.querySelectorAll('body *')]
					.filter(el => !el.closest('.table-scroll') && el.getBoundingClientRect().right > window.innerWidth + 1)
					.map(el => `${el.tagName.toLowerCase()}.${el.className}`).slice(0, 5);
				return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, widest };
			});
			assert.ok(overflow.scrollWidth <= overflow.innerWidth,
				`${label} is ${overflow.scrollWidth}px wide on a ${overflow.innerWidth}px screen (${overflow.widest.join(', ')})`);
		};
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
		await page.getByRole('link', { name: 'Your detailed dashboard', exact: true }).click();
		await page.waitForURL('**/dashboard');
		await assertFitsPhone('/dashboard');
		await page.locator('details.card > summary').click();
		assert.equal(await page.locator('.breakdown-table tbody tr').count(), 1);
		await assertFitsPhone('/dashboard with the detailed breakdown open');
		await page.setViewportSize({ width: 320, height: 640 });
		await assertFitsPhone('/dashboard on a small phone');
		await page.getByRole('link', { name: 'Team Insights', exact: true }).click();
		await page.waitForURL('**/team');
		await assertFitsPhone('/team on a small phone');
		await page.setViewportSize({ width: 390, height: 844 });
		await assertFitsPhone('/team');
		await page.getByRole('link', { name: 'Sign out', exact: true }).click();
		await page.waitForURL('**/dashboard');
		await page.goto(`${baseUrl}/team`);
		assert.equal(new URL(page.url()).pathname, '/dashboard');
		assertPrivate(await page.content());
		assert.deepEqual(errors, [], 'browser runtime errors');
		const noScript = await browser.newContext({ javaScriptEnabled: false });
		await noScript.addCookies([{
			name: fixture.COOKIE_NAME, value: fixture.encodeSession(fixture.makeClaims(viewer.id)),
			url: baseUrl, httpOnly: true, sameSite: 'Lax',
		}]);
		const plainPage = await noScript.newPage();
		await plainPage.goto(`${baseUrl}/team`);
		for (const days of [7, 90, 30]) {
			await plainPage.getByRole('link', { name: `Last ${days} days`, exact: true }).click();
			await plainPage.waitForURL(`**/team?days=${days}`);
			assert.equal(await plainPage.locator('#team-daily-numbers tbody tr').count(), days);
			assertPrivate(await plainPage.content());
		}
		const boundary = fixture.upsertUser(78005, 'boundary-user', 'Boundary User', null);
		fixture.upsertUpload(boundary.id, {
			day: today, workspaceId: 'boundary-workspace', machineId: 'boundary-machine', model: 'boundary-model',
			inputTokens: 999_949_999, outputTokens: 0, interactions: 1,
		});
		fixture.getDb().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(boundary.id);
		await context.addCookies([{
			name: fixture.COOKIE_NAME, value: fixture.encodeSession(fixture.makeClaims(boundary.id)),
			url: baseUrl, httpOnly: true, sameSite: 'Lax',
		}]);
		await page.goto(`${baseUrl}/dashboard`);
		const personalChart = await page.evaluate(() => {
			const chart = Chart.getChart(document.getElementById('trend-chart'));
			const dataset = chart.data.datasets.find(item => item.label === 'boundary-model');
			const value = dataset.data.at(-1);
			return { value, tooltip: chart.options.plugins.tooltip.callbacks.label({ parsed: { y: value }, dataset }) };
		});
		assert.deepEqual(personalChart, { value: 999_949_999, tooltip: '  boundary-model: 999.9M tokens' });
		await page.goto(`${baseUrl}/admin`);
		const adminChart = await page.evaluate(() => {
			const chart = Chart.getChart(document.getElementById('admin-trend-chart'));
			const dataset = chart.data.datasets.find(item => item.label === 'boundary-user');
			const value = dataset.data.at(-1);
			return { value, tooltip: chart.options.plugins.tooltip.callbacks.label({ parsed: { y: value }, dataset }) };
		});
		assert.deepEqual(adminChart, { value: 999_949_999, tooltip: '  boundary-user: 999.9M tokens' });
		await page.locator('#admin-mode-tabs [data-admin-mode="average"]').click();
		assert.equal(await page.evaluate(() => Chart.getChart(document.getElementById('admin-trend-chart')).data.datasets[0].data.at(-1)), (999_949_999 + 1000) / 5);
		await assertFitsPhone('/admin');
		await page.goto(`${baseUrl}/dashboard`);
		await assertFitsPhone('/dashboard as an admin');
		await page.setViewportSize({ width: 320, height: 640 });
		await assertFitsPhone('/dashboard as an admin on a small phone');
		await page.goto(`${baseUrl}/admin`);
		await assertFitsPhone('/admin on a small phone');
		// Crossing the breakpoint after load (rotating a phone) must re-tune the charts, not only resize them.
		const adminTicks = () => page.evaluate(() => Chart.getChart(document.getElementById('admin-trend-chart')).options.scales.x.ticks.maxTicksLimit);
		assert.equal(await adminTicks(), 6);
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.waitForFunction(() => Chart.getChart(document.getElementById('admin-trend-chart')).options.scales.x.ticks.maxTicksLimit === 20);
		await page.goto(`${baseUrl}/team`);
		const teamChart = () => page.evaluate(() => {
			const { x, y } = Chart.getChart(document.getElementById('team-trend-chart')).options.scales;
			return { ticks: x.ticks.maxTicksLimit, title: y.title.display };
		});
		assert.deepEqual(await teamChart(), { ticks: 12, title: true });
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForFunction(() => Chart.getChart(document.getElementById('team-trend-chart')).options.scales.x.ticks.maxTicksLimit === 6);
		assert.deepEqual(await teamChart(), { ticks: 6, title: false });
		await page.goto(`${baseUrl}/dashboard`);
		await page.waitForFunction(() => Chart.getChart(document.getElementById('trend-chart')).options.scales.x.ticks.maxTicksLimit === 6);
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.waitForFunction(() => {
			const { x, y } = Chart.getChart(document.getElementById('trend-chart')).options.scales;
			return x.ticks.maxTicksLimit === 16 && y.title.display === true;
		});
		assert.deepEqual(errors, [], 'browser runtime errors');
		console.log('Team interactions passed: period navigation (with/without JS), chart modes, daily table, exports, phone layout on every page, own dashboard, sign-out, privacy.');
	} finally {
		if (browser) await browser.close();
		if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		if (closeDb) closeDb();
		rmSync(scratch, { recursive: true, force: true });
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
