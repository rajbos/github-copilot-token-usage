#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the internal-host guard, plain-http warning and HEAD→GET
 * retry policy in check-urls.js. No test touches the network: DNS lookups and
 * HTTP requests are stubbed.
 *
 * Run with:  node --test .github/skills/check-urls/check-urls.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    HEAD_RETRY_STATUSES,
    extractUrls,
    isPlainHttp,
    getInternalAddressReason,
    getInternalHostReason,
    getResolvedInternalReason,
    guardedLookup,
    checkUrl,
    checkUrlWithMethod,
    partitionInternalUrls,
} = require('./check-urls.js');

/** Hostname exactly as the script sees it: via URL parsing. */
const hostOf = (url) => new URL(url).hostname;

test('localhost names are internal', () => {
    for (const url of ['http://localhost/', 'https://LOCALHOST:8080/x', 'http://api.localhost/', 'http://localhost./']) {
        assert.equal(getInternalHostReason(hostOf(url)), 'localhost', url);
    }
});

test('IPv4 internal ranges are labelled', () => {
    const cases = {
        'http://127.0.0.1/': 'loopback',
        'http://127.255.0.9/': 'loopback',
        'http://169.254.169.254/latest/meta-data/': 'link-local',
        'http://10.1.2.3/': 'private',
        'http://172.16.0.1/': 'private',
        'http://172.31.255.255/': 'private',
        'http://192.168.1.1/': 'private',
        'http://0.0.0.0/': 'unspecified',
        'http://100.64.0.1/': 'carrier-grade NAT',
    };
    for (const [url, label] of Object.entries(cases)) {
        assert.equal(getInternalHostReason(hostOf(url)), label, url);
    }
});

test('IPv4 alternate notations are normalised by URL parsing and still caught', () => {
    // WHATWG URL turns these into dotted-quad 127.0.0.1 / 169.254.169.254
    assert.equal(getInternalHostReason(hostOf('http://2130706433/')), 'loopback');
    assert.equal(getInternalHostReason(hostOf('http://0x7f.1/')), 'loopback');
    assert.equal(getInternalHostReason(hostOf('http://0xa9fea9fe/')), 'link-local');
});

test('IPv6 internal ranges are labelled', () => {
    const cases = {
        'http://[::1]/': 'loopback',
        'http://[::]/': 'unspecified',
        'http://[fe80::1]/': 'link-local',
        'http://[febf::1]/': 'link-local',
        'http://[fc00::1]/': 'private',
        'http://[fd12:3456::1]/': 'private',
    };
    for (const [url, label] of Object.entries(cases)) {
        assert.equal(getInternalHostReason(hostOf(url)), label, url);
    }
});

test('IPv4-mapped IPv6 addresses are judged by their IPv4 part', () => {
    assert.equal(getInternalHostReason(hostOf('http://[::ffff:10.0.0.1]/')), 'private');
    assert.equal(getInternalHostReason(hostOf('http://[::ffff:169.254.169.254]/')), 'link-local');
    assert.equal(getInternalAddressReason('::ffff:127.0.0.1'), 'loopback');
    assert.equal(getInternalHostReason(hostOf('http://[::ffff:8.8.8.8]/')), null);
});

test('public hosts and addresses are not internal', () => {
    for (const url of [
        'https://code.visualstudio.com/docs',
        'http://8.8.8.8/',
        'http://172.32.0.1/',
        'http://172.15.255.255/',
        'http://192.169.0.1/',
        'http://[2001:4860:4860::8888]/',
        'http://[fec0::1]/',
        'https://notlocalhost.example/',
    ]) {
        assert.equal(getInternalHostReason(hostOf(url)), null, url);
    }
});

test('getResolvedInternalReason flags hosts that resolve to internal addresses', async () => {
    const lookup = async (host) => ({
        'internal.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
        'public.example': [{ address: '93.184.216.34', family: 4 }],
        'v6.example': [{ address: 'fe80::abcd', family: 6 }],
    })[host];
    assert.equal(await getResolvedInternalReason('internal.example', lookup), 'private (internal.example resolves to 10.0.0.5)');
    assert.equal(await getResolvedInternalReason('v6.example', lookup), 'link-local (v6.example resolves to fe80::abcd)');
    assert.equal(await getResolvedInternalReason('public.example', lookup), null);
});

test('getResolvedInternalReason returns null when lookup fails and skips DNS for IP literals', async () => {
    const failing = async () => { throw new Error('ENOTFOUND'); };
    assert.equal(await getResolvedInternalReason('missing.example', failing), null);
    const neverCalled = async () => { throw new Error('should not resolve an IP literal'); };
    assert.equal(await getResolvedInternalReason('[::1]', neverCalled), 'loopback');
    assert.equal(await getResolvedInternalReason('8.8.8.8', neverCalled), null);
});

test('partitionInternalUrls skips internal hosts and keeps public and invalid URLs', async () => {
    const lookup = async (host) => (host === 'rebind.example'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }]);
    const { toCheck, skipped } = await partitionInternalUrls([
        'https://example.com/',
        'http://localhost:3000/',
        'http://169.254.169.254/latest/meta-data/',
        'https://rebind.example/',
        'http://[',
    ], lookup);
    assert.deepEqual(toCheck, ['https://example.com/', 'http://[']);
    assert.deepEqual(skipped.map((s) => s.url), [
        'http://localhost:3000/',
        'http://169.254.169.254/latest/meta-data/',
        'https://rebind.example/',
    ]);
    assert.match(skipped[2].reason, /^loopback \(rebind\.example resolves to 127\.0\.0\.1\)$/);
});

test('extractUrls keeps the closing bracket of IPv6 hosts', () => {
    const text = [
        "const a = 'http://[::1]/health';",
        'see http://[fe80::1]:8080/x.',
        '(http://[fd00::2])',
        '`http://[::ffff:10.0.0.1]`',
        'http://[::1]',
    ].join('\n');
    assert.deepEqual([...extractUrls(text)], [
        'http://[::1]/health',
        'http://[fe80::1]:8080/x',
        'http://[fd00::2]',
        'http://[::ffff:10.0.0.1]',
        'http://[::1]',
    ]);
});

test('extractUrls keeps its existing behaviour for ordinary URLs', () => {
    const text = 'see https://example.com/a. (https://example.org/b) [link](https://x.test/c) https:// https://${host}/p';
    assert.deepEqual([...extractUrls(text)], ['https://example.com/a', 'https://example.org/b', 'https://x.test/c']);
});

test('IPv6 URLs extracted from source are SKIPPED, not reported as invalid', async () => {
    const neverCalled = async () => { throw new Error('IP literals must not be resolved'); };
    const urls = [...extractUrls("fetch('http://[::1]/x'); fetch('http://[fe80::1]:8080/'); fetch('https://[2001:4860:4860::8888]/')")];
    const { toCheck, skipped } = await partitionInternalUrls(urls, neverCalled);
    assert.deepEqual(skipped.map((s) => [s.url, s.reason]), [
        ['http://[::1]/x', 'loopback'],
        ['http://[fe80::1]:8080/', 'link-local'],
    ]);
    assert.deepEqual(toCheck, ['https://[2001:4860:4860::8888]/']);
});

test('IPv6 literals are classified directly, never via DNS', async () => {
    const neverCalled = async () => { throw new Error('IP literals must not be resolved'); };
    const { toCheck, skipped } = await partitionInternalUrls([
        'http://[::1]/',
        'http://[fc00::]/',
        'http://[fe80::]/',
        'http://[::ffff:10.0.0.1]/',
        'https://[2606:4700::1111]/',
    ], neverCalled);
    assert.deepEqual(skipped.map((s) => s.reason), ['loopback', 'private', 'link-local', 'private']);
    assert.deepEqual(toCheck, ['https://[2606:4700::1111]/']);
});

/** Replace http(s).request for one call, capturing the options it was given. */
async function captureRequest(url) {
    const http = require('node:http');
    const https = require('node:https');
    const { EventEmitter } = require('node:events');
    const originals = { http: http.request, https: https.request };
    const calls = [];
    const fake = (options, onResponse) => {
        calls.push(options);
        const req = new EventEmitter();
        req.end = () => onResponse({ statusCode: 204, resume() {} });
        req.destroy = () => {};
        return req;
    };
    http.request = fake;
    https.request = fake;
    try {
        const result = await checkUrlWithMethod(url, 'HEAD');
        return { result, calls };
    } finally {
        http.request = originals.http;
        https.request = originals.https;
    }
}

test('checkUrlWithMethod passes public IPv6 literals to Node unbracketed', async () => {
    const { result, calls } = await captureRequest('https://[2606:4700::1111]/dns-query?x=1');
    assert.equal(result.status, 204);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, '2606:4700::1111');
    assert.equal(calls[0].path, '/dns-query?x=1');
});

test('checkUrlWithMethod refuses internal literals without sending a request', async () => {
    for (const [url, reason] of [
        ['http://[::1]:8080/', 'loopback'],
        ['http://[fc00::]/', 'private'],
        ['http://[fe80::]/', 'link-local'],
        ['http://[::ffff:10.0.0.1]/', 'private'],
        ['http://169.254.169.254/', 'link-local'],
        ['http://localhost/', 'localhost'],
    ]) {
        const { result, calls } = await captureRequest(url);
        assert.equal(calls.length, 0, url);
        assert.equal(result.status, null, url);
        assert.match(result.error, new RegExp(`^blocked ${reason} host `), url);
    }
});

test('guardedLookup unbrackets the hostname it resolves', async () => {
    const seen = await new Promise((resolve) => {
        guardedLookup('[2606:4700::1111]', {}, () => {}, (host, _o, cb) => { resolve(host); cb(null, '2606:4700::1111', 6); });
    });
    assert.equal(seen, '2606:4700::1111');
});

test('guardedLookup blocks internal answers at connect time', async () => {
    const run = (answer, options = {}) => new Promise((resolve) => {
        const fakeLookup = (_host, _opts, cb) => cb(null, ...answer);
        guardedLookup('host.example', options, (err, address) => resolve({ err, address }), fakeLookup);
    });

    const single = await run(['192.168.0.10', 4]);
    assert.match(single.err.message, /blocked private address 192\.168\.0\.10/);

    const all = await run([[{ address: '1.1.1.1', family: 4 }, { address: '::1', family: 6 }]], { all: true });
    assert.match(all.err.message, /blocked loopback address ::1/);

    const ok = await run(['1.1.1.1', 4]);
    assert.equal(ok.err, null);
    assert.equal(ok.address, '1.1.1.1');
});

test('guardedLookup passes lookup errors through', async () => {
    const err = await new Promise((resolve) => {
        guardedLookup('x', {}, (e) => resolve(e), (_h, _o, cb) => cb(new Error('ENOTFOUND')));
    });
    assert.equal(err.message, 'ENOTFOUND');
});

test('isPlainHttp flags http: but not https:', () => {
    assert.equal(isPlainHttp('http://example.com/'), true);
    assert.equal(isPlainHttp('HTTP://example.com/'), true);
    assert.equal(isPlainHttp('https://example.com/'), false);
});

test('checkUrl retries HEAD with GET only for 403, 405 and 501', async () => {
    assert.deepEqual([...HEAD_RETRY_STATUSES].sort(), [403, 405, 501]);
    for (const headStatus of [200, 301, 400, 401, 403, 404, 405, 410, 429, 500, 501, 503, null]) {
        const methods = [];
        const request = async (_url, method) => {
            methods.push(method);
            return method === 'HEAD' ? { status: headStatus, error: headStatus === null ? 'timeout' : undefined } : { status: 200 };
        };
        const result = await checkUrl('https://example.com/', request);
        if (HEAD_RETRY_STATUSES.has(headStatus)) {
            assert.deepEqual(methods, ['HEAD', 'GET'], `HEAD ${headStatus}`);
            assert.equal(result.status, 200);
        } else {
            assert.deepEqual(methods, ['HEAD'], `HEAD ${headStatus}`);
            assert.equal(result.status, headStatus);
        }
    }
});
