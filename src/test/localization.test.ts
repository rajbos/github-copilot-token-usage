import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createLocalization, formatMessage } from '../localization';

const loc = createLocalization({
	english: { greet: 'Hello {0}', onlyEnglish: 'English only' },
	locales: { 'zh-cn': { greet: '你好 {0}' } },
});

test('translate uses the locale bundle, then English, then the key itself', () => {
	assert.equal(loc.translate('zh-cn', 'greet', 'Rob'), '你好 Rob');
	assert.equal(loc.translate('zh-cn', 'onlyEnglish'), 'English only');
	assert.equal(loc.translate('fr', 'greet', 'Rob'), 'Hello Rob');
	assert.equal(loc.translate('en', 'missing.key'), 'missing.key');
});

test('createTranslator binds one language', () => {
	assert.equal(loc.createTranslator('zh-Hans-CN')('greet', 1), '你好 1');
	assert.equal(loc.createTranslator('en')('greet', 1), 'Hello 1');
});

test('resolvedLocale matches by language and script, never by prototype keys', () => {
	assert.equal(loc.resolvedLocale('zh-CN'), 'zh-cn');
	assert.equal(loc.resolvedLocale('zh-SG'), 'zh-cn');
	assert.equal(loc.resolvedLocale('zh-TW'), 'en');
	assert.equal(loc.resolvedLocale('constructor'), 'en');
	assert.equal(loc.resolvedLocale('__proto__'), 'en');
	assert.equal(loc.resolvedLocale(''), 'en');
});

test('formatMessage leaves placeholders without an argument in place', () => {
	assert.equal(formatMessage('{0} and {1}', ['a']), 'a and {1}');
});
