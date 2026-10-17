import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyWebviewLocale } from '../../src/webview/shared/webviewLocale';
import { getCurrentLanguage, localize, initializeWebviewLocalization } from '../../src/webview/shared/localization';
import { setFormatLocale, formatNumber } from '../../src/webview/shared/formatUtils';

// ── Coverage for the one place a bundle applies its locale payload ───────────
//
// The rule under test: a field is applied only when the payload carries it. This is not
// cosmetic. `applyWebviewLocale` runs on refresh payloads as well as initial ones, and the
// JetBrains host's refresh (`TokenTrackerPanel.pushStatsToWebview()`) dispatches stats plus
// settings with no `locale`, `language` or `localization` at all. While absence meant "reset",
// every one of those refreshes silently reverted a zh-CN panel to English and a German
// developer's `1.234,56` to the runtime default.
//
// Formatting is asserted through formatNumber() rather than a getter, because the locale is
// module state with no reader — the rendered number is the only observable.

/** A German thousands separator proves the formatting locale is in force. */
const GERMAN_GROUPED = formatNumberWith('de-DE', 1234567);

function formatNumberWith(locale: string, value: number): string {
	return new Intl.NumberFormat(locale).format(value);
}

describe('applyWebviewLocale', () => {
	beforeEach(() => {
		// Back to the module defaults each time: 'en' and the runtime locale.
		applyWebviewLocale({ language: 'en', locale: undefined });
		setFormatLocale(undefined);
		initializeWebviewLocalization({});
	});

	test('applies language and formatting locale from a full initial payload', () => {
		applyWebviewLocale({ language: 'zh-cn', locale: 'de-DE', localization: { 'nav.btnDetails': '详情' } });
		assert.equal(getCurrentLanguage(), 'zh-cn');
		assert.equal(formatNumber(1234567), GERMAN_GROUPED);
		assert.equal(localize('nav.btnDetails'), '详情');
	});

	test('a refresh payload carrying none of the three fields changes nothing', () => {
		applyWebviewLocale({ language: 'zh-cn', locale: 'de-DE', localization: { 'nav.btnDetails': '详情' } });

		// The JetBrains refresh shape: the view's stats and settings, no locale fields.
		applyWebviewLocale({ totalTokens: 42, use24HourTime: true } as never);

		assert.equal(getCurrentLanguage(), 'zh-cn', 'display language was reset by a refresh');
		assert.equal(formatNumber(1234567), GERMAN_GROUPED, 'formatting locale was reset by a refresh');
		assert.equal(localize('nav.btnDetails'), '详情', 'dictionary was reset by a refresh');
	});

	test('a refresh still applies the fields it does carry', () => {
		applyWebviewLocale({ language: 'zh-cn', locale: 'de-DE' });
		applyWebviewLocale({ language: 'en' });
		assert.equal(getCurrentLanguage(), 'en', 'an explicit language on a refresh should win');
		assert.equal(formatNumber(1234567), GERMAN_GROUPED, 'the untouched locale should survive');

		applyWebviewLocale({ locale: 'en-US' });
		assert.equal(formatNumber(1234567), formatNumberWith('en-US', 1234567));
		assert.equal(getCurrentLanguage(), 'en');
	});

	test('reads the language out of the dictionary when the host has nowhere else to put it', () => {
		// The JetBrains and Visual Studio sidecar channel.
		applyWebviewLocale({ localization: { '__language__': 'zh-cn' } });
		assert.equal(getCurrentLanguage(), 'zh-cn');
	});

	test('a real language field beats the one riding inside the dictionary', () => {
		applyWebviewLocale({ language: 'en', localization: { '__language__': 'zh-cn' } });
		assert.equal(getCurrentLanguage(), 'en');
	});

	test('null and undefined payloads are no-ops rather than resets', () => {
		applyWebviewLocale({ language: 'zh-cn', locale: 'de-DE' });
		applyWebviewLocale(undefined);
		applyWebviewLocale(null);
		assert.equal(getCurrentLanguage(), 'zh-cn');
		assert.equal(formatNumber(1234567), GERMAN_GROUPED);
	});
});
