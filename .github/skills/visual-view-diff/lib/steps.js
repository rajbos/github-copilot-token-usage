'use strict';

/**
 * Replays declared UI steps on a rendered view page.
 *
 * A step is `{ "click": "<selector>" }`, `{ "select": "<selector>", "value"?: "<option>" }`,
 * `{ "type": "<selector>", "text": "..." }` (fill a text input), `{ "press": "<key>" }` (keyboard)
 * or `{ "post": { "command": "...", ... } }` — the same shape `views.config.json`
 * uses for interaction-smoke `scenarios`, so a view's `states` (the tabs and
 * modes the visual diff screenshots) and its scenarios read alike and share one
 * vocabulary.
 *
 * `post` plays the extension host: it delivers a message to the view exactly
 * as VS Code would relay one, for the tabs that ask the host for data on open
 * and would otherwise only ever screenshot their loading placeholder. The
 * harness records what the view posts but answers nothing on its own, so the
 * answer has to be declared with the state, and it has to be deterministic
 * (fixed dates, no `fetchedAt` that renders as "n minutes ago").
 *
 * This module only drives the page. What to conclude from a step — a smoke
 * finding, a screenshot, an error — is the caller's business.
 */

/**
 * Runs inside the page. Picks the value a `select` step should switch to: the
 * declared one, or the first enabled option that is not already selected.
 * `noop` means the select has nothing else to offer, which is a legitimate
 * no-op rather than a failure.
 */
const PICK_OPTION = ([selector, wanted]) => {
	const el = document.querySelector(selector);
	if (!el) {
		return { missing: true };
	}
	const options = Array.from(el.options).filter((o) => !o.disabled);
	if (wanted !== null && wanted !== undefined) {
		return options.some((o) => o.value === wanted) ? { value: wanted } : { unavailable: true };
	}
	const next = options.find((o) => o.value !== el.value);
	return next ? { value: next.value } : { noop: true };
};

/**
 * Runs inside the page. "Showing" means present *and* rendered — not
 * `display:none`, not `visibility:hidden`, not zero-sized — which is the same
 * test the interaction crawl applies to a control before clicking it.
 */
const IS_SHOWING = (selector) => {
	const el = document.querySelector(selector);
	if (!el) {
		return false;
	}
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) {
		return false;
	}
	const style = window.getComputedStyle(el);
	return style.visibility !== 'hidden' && style.display !== 'none';
};

function describeStep(step) {
	if (step.click) { return `click ${step.click}`; }
	if (step.post) { return `post ${step.post && step.post.command ? step.post.command : 'message'}`; }
	if (step.type) { return `type "${step.text ?? ''}" into ${step.type}`; }
	if (step.press) { return `press ${step.press}`; }
	return `select ${step.select}${step.value ? ` = ${step.value}` : ''}`;
}

/**
 * Runs inside the page. A MessageEvent with no `source` is what the shared
 * message handler treats as the host itself (rule 1 in
 * `webview/shared/messageHandler.ts`), the same way the unit-test harness
 * delivers host messages.
 */
const DISPATCH_HOST_MESSAGE = (message) => {
	window.dispatchEvent(new MessageEvent('message', { data: message }));
};

/**
 * Applies one step. Resolves to `null` on success or a short reason string on
 * failure; never throws for an ordinary "control not there" case.
 */
async function applyStep(page, step) {
	if (step.click) {
		try {
			await page.locator(step.click).first().click({ timeout: 2000, noWaitAfter: true });
			return null;
		} catch (error) {
			return `could not click: ${String(error && error.message || error).split('\n')[0]}`;
		}
	}
	if (step.type) {
		try {
			await page.locator(step.type).first().fill(String(step.text ?? ''), { timeout: 2000 });
			return null;
		} catch (error) {
			return `could not type: ${String(error && error.message || error).split('\n')[0]}`;
		}
	}
	if (step.press) {
		try {
			await page.keyboard.press(step.press);
			return null;
		} catch (error) {
			return `could not press: ${String(error && error.message || error).split('\n')[0]}`;
		}
	}
	if (step.post) {
		if (!step.post || typeof step.post !== 'object') { return '"post" must be a message object'; }
		try {
			await page.evaluate(DISPATCH_HOST_MESSAGE, step.post);
			return null;
		} catch (error) {
			return `could not deliver the message: ${String(error && error.message || error).split('\n')[0]}`;
		}
	}
	if (step.select) {
		const pick = await page.evaluate(PICK_OPTION, [step.select, step.value ?? null]);
		if (pick.missing) { return 'the select is not on screen'; }
		if (pick.unavailable) { return `option '${step.value}' is not offered`; }
		if (pick.noop) { return null; }
		try {
			await page.selectOption(step.select, pick.value, { timeout: 2000 });
			return null;
		} catch (error) {
			return `could not change: ${String(error && error.message || error).split('\n')[0]}`;
		}
	}
	return 'step has none of "click", "select", "type", "press" or "post"';
}

/**
 * Applies every step in order, stopping at the first failure.
 *
 * @returns {{ ok: true } | { ok: false, step: string, reason: string }}
 */
async function applySteps(page, steps, { pauseMs = 120 } = {}) {
	for (const step of steps || []) {
		const reason = await applyStep(page, step);
		if (reason) {
			return { ok: false, step: describeStep(step), reason };
		}
		await page.waitForTimeout(pauseMs);
	}
	return { ok: true };
}

/** True when `selector` is present and rendered on the page. */
function isShowing(page, selector) {
	return page.evaluate(IS_SHOWING, selector);
}

module.exports = { PICK_OPTION, IS_SHOWING, applyStep, applySteps, isShowing, describeStep };
