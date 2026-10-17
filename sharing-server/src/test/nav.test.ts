/**
 * Unit tests for the downstream nav-link hook.
 *
 * The rendered links are interpolated straight into the dashboard header, so the
 * escaping and same-origin rules are a security boundary, not cosmetics: these tests
 * pin the behaviour that stops a bad link from injecting markup or navigating off the
 * server, including the URL-normalisation tricks that defeat a naive prefix check.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { renderNavExtra, navExtraMiddleware, type NavLink } from '../nav.js';
import { createApp } from '../app.js';
import { closeDb, upsertUser, type UserRow } from '../db.js';
import { COOKIE_NAME, encodeSession, makeClaims } from '../session.js';

/**
 * Render the header fragment the way a page does: through a real request, so the
 * provider is read from the context rather than from any module state.
 */
async function render(provider: () => NavLink[], currentPath?: string): Promise<string> {
	const app = new Hono();
	app.use('*', navExtraMiddleware(provider));
	app.get('/probe', (c) => c.text(renderNavExtra(c, currentPath)));
	return (await app.request('/probe')).text();
}

describe('renderNavExtra', () => {
	test('renders nothing when no provider is registered', async () => {
		const app = new Hono();
		app.get('/probe', (c) => c.text(renderNavExtra(c, '/dashboard')));
		assert.equal(await (await app.request('/probe')).text(), '');
	});

	test('renders a registered link as an anchor', async () => {
		const html = await render(() => [{ href: '/vendor', label: 'Vendor Insights' }]);
		assert.equal(html, '<a href="/vendor">Vendor Insights</a>');
	});

	test('marks the active link with aria-current', async () => {
		const links = () => [{ href: '/vendor', label: 'Vendor' }];
		assert.match(await render(links, '/vendor'), /aria-current="page"/);
		assert.doesNotMatch(await render(links, '/dashboard'), /aria-current/);
	});

	test('includes an optional title attribute', async () => {
		const html = await render(() => [{ href: '/vendor', label: 'Vendor', title: 'Extra metrics' }]);
		assert.match(html, /title="Extra metrics"/);
	});

	test('escapes the label and title rather than emitting raw markup', async () => {
		const html = await render(() => [{ href: '/vendor', label: '<script>x</script>', title: 'a"b' }]);
		assert.doesNotMatch(html, /<script/i);
		assert.match(html, /&lt;script&gt;/);
		// An unescaped quote here would let the title break out into a new attribute.
		assert.match(html, /title="a&quot;b"/);
	});

	test('drops links that are not same-origin paths', async () => {
		const html = await render((): NavLink[] => [
			{ href: 'https://evil.example/x', label: 'Absolute' },
			{ href: '//evil.example/x', label: 'Protocol-relative' },
			{ href: 'javascript:alert(1)', label: 'Script' },
			{ href: 'vendor', label: 'Relative' },
			{ href: '', label: 'Empty' },
			{ href: '/ok', label: 'Kept' },
		]);
		assert.equal(html, '<a href="/ok">Kept</a>');
	});

	test('drops hrefs that browsers normalise into another origin', async () => {
		// Each of these passes a naive startsWith('/') && !startsWith('//') check, but a
		// browser rewrites the backslash or strips the control character and ends up
		// navigating to evil.example.
		for (const href of ['/\\evil.example/x', '/\n//evil.example', '/\t//evil.example', '/\r//evil.example']) {
			assert.equal(
				await render(() => [{ href, label: 'Bypass' }]),
				'',
				`expected ${JSON.stringify(href)} to be rejected`,
			);
			// Guard the reasoning itself: confirm the input really does change origin.
			assert.notEqual(new URL(href, 'https://nav.invalid').origin, 'https://nav.invalid');
		}
	});

	test('keeps ordinary paths with queries, fragments and encoded characters', async () => {
		const html = await render(() => [{ href: '/vendor?days=30#top', label: 'Vendor' }]);
		assert.match(html, /href="\/vendor\?days=30#top"/);
	});

	test('drops malformed entries without throwing', async () => {
		const html = await render(() => ([
			null,
			{ label: 'No href' },
			{ href: '/x' },
			{ href: '/ok', label: 'Kept' },
		] as unknown as NavLink[]));
		assert.equal(html, '<a href="/ok">Kept</a>');
	});

	test('drops an entry whose optional title is not a string', async () => {
		// A non-string title would otherwise reach escapeHtml() and throw *outside* the
		// provider try/catch, taking the whole page down instead of degrading.
		const html = await render(() => ([
			{ href: '/bad', label: 'Bad', title: { toString: () => 'x' } },
			{ href: '/ok', label: 'Kept' },
		] as unknown as NavLink[]));
		assert.equal(html, '<a href="/ok">Kept</a>');
	});

	test('a throwing provider degrades to no links instead of breaking the page', async () => {
		assert.equal(await render(() => { throw new Error('boom'); }, '/dashboard'), '');
	});

	test('a provider returning a non-array degrades to no links', async () => {
		assert.equal(await render((() => 'nope') as unknown as () => NavLink[]), '');
	});

	test('is re-evaluated on every render so the list can change', async () => {
		let label = 'First';
		const provider = () => [{ href: '/vendor', label }];
		assert.match(await render(provider), /First/);
		label = 'Second';
		assert.match(await render(provider), /Second/);
	});
});

describe('createApp navExtra wiring', () => {
	test('registers the provider passed to createApp', async () => {
		const app = createApp({
			navExtra: () => [{ href: '/vendor', label: 'Vendor' }],
			extend: (a) => { a.get('/probe', (c) => c.text(renderNavExtra(c))); },
		});
		assert.equal(await (await app.request('/probe')).text(), '<a href="/vendor">Vendor</a>');
	});

	test('two apps in one process keep their own links', async () => {
		// The provider lives on the request context, not in module state, so composing a
		// second app must not silently retarget the first app's headers.
		const first = createApp({
			navExtra: () => [{ href: '/first', label: 'First' }],
			extend: (a) => { a.get('/probe', (c) => c.text(renderNavExtra(c))); },
		});
		const second = createApp({
			navExtra: () => [{ href: '/second', label: 'Second' }],
			extend: (a) => { a.get('/probe', (c) => c.text(renderNavExtra(c))); },
		});
		const third = createApp({
			extend: (a) => { a.get('/probe', (c) => c.text(renderNavExtra(c))); },
		});

		assert.equal(await (await first.request('/probe')).text(), '<a href="/first">First</a>');
		assert.equal(await (await second.request('/probe')).text(), '<a href="/second">Second</a>');
		assert.equal(await (await third.request('/probe')).text(), '');
		// Re-check the first app last: creating the others must not have disturbed it.
		assert.equal(await (await first.request('/probe')).text(), '<a href="/first">First</a>');
	});
});

/**
 * The hook is only useful if the links actually reach the page headers. These tests
 * render each built-in page end to end, so removing a `renderNavExtra()` call from a
 * header fails here rather than silently stranding a downstream page at URL-only.
 */
describe('downstream links reach the built-in page headers', () => {
	let dataDir: string;
	let user: UserRow;
	const previousDataDir = process.env.LOCAL_DATA_DIR;
	const previousAdmins = process.env.ADMIN_GITHUB_LOGINS;

	before(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'sharing-nav-'));
		process.env.LOCAL_DATA_DIR = dataDir;
		process.env.ADMIN_GITHUB_LOGINS = 'nav-admin';
		user = upsertUser(920001, 'nav-admin', 'Nav Admin', null);
	});

	after(() => {
		closeDb();
		if (previousDataDir === undefined) delete process.env.LOCAL_DATA_DIR;
		else process.env.LOCAL_DATA_DIR = previousDataDir;
		if (previousAdmins === undefined) delete process.env.ADMIN_GITHUB_LOGINS;
		else process.env.ADMIN_GITHUB_LOGINS = previousAdmins;
		rmSync(dataDir, { recursive: true, force: true });
	});

	for (const path of ['/dashboard', '/team', '/admin']) {
		test(`${path} header links to the downstream page`, async () => {
			const app = createApp({ navExtra: () => [{ href: '/vendor', label: 'Vendor Insights' }] });
			const res = await app.request(path, {
				headers: { Cookie: `${COOKIE_NAME}=${encodeSession(makeClaims(user.id))}` },
			});
			assert.equal(res.status, 200, `expected ${path} to render`);
			const html = await res.text();
			assert.ok(
				html.includes('<a href="/vendor">Vendor Insights</a>'),
				`expected the downstream nav link in the ${path} header`,
			);
		});
	}

	test('pages still render when no downstream links are registered', async () => {
		const app = createApp();
		const res = await app.request('/dashboard', {
			headers: { Cookie: `${COOKIE_NAME}=${encodeSession(makeClaims(user.id))}` },
		});
		assert.equal(res.status, 200);
		assert.doesNotMatch(await res.text(), /href="\/vendor"/);
	});

	// Mirrors the composition documented in README.md "Extending this server".
	// The link a downstream server advertises has to resolve to a real page.
	describe('the documented README composition', () => {
		const buildDocumentedApp = () => {
			const routes = new Hono();
			routes.post('/upload', (c) => c.json({ ok: true }));

			const page = new Hono();
			page.get('/mine', (c) =>
				c.html(`<!doctype html><html><body>
					<header>
						<a href="/dashboard">My Dashboard</a>
						<a href="/team">Team Insights</a>
						${renderNavExtra(c, '/mine')}
					</header>
					<main>…</main>
				</body></html>`),
			);

			return createApp({
				healthExtra: () => ({ edition: 'my-company' }),
				navExtra: () => [{ href: '/mine', label: 'My Insights' }],
				extend: (a) => a.route('/api/mine', routes).route('/', page),
			});
		};

		test('the advertised href resolves instead of 404ing', async () => {
			const res = await buildDocumentedApp().request('/mine');
			assert.equal(res.status, 200, 'the documented nav target must be a registered route');
		});

		test('built-in headers link to the documented page', async () => {
			const res = await buildDocumentedApp().request('/dashboard', {
				headers: { Cookie: `${COOKIE_NAME}=${encodeSession(makeClaims(user.id))}` },
			});
			assert.equal(res.status, 200);
			assert.ok((await res.text()).includes('<a href="/mine">My Insights</a>'));
		});

		test('the downstream page renders its own links through renderNavExtra', async () => {
			const html = await (await buildDocumentedApp().request('/mine')).text();
			assert.ok(html.includes('My Insights'), 'expected renderNavExtra output in the page header');
			assert.ok(html.includes('href="/dashboard"'), 'expected the back-links to the built-in pages');
		});

		test('healthExtra from the documented example is merged', async () => {
			const res = await buildDocumentedApp().request('/health');
			assert.equal(((await res.json()) as { edition?: string }).edition, 'my-company');
		});
	});
});
