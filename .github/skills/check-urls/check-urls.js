#!/usr/bin/env node

/**
 * URL Resolution Check Script
 *
 * Scans all TypeScript source files under src/ for hardcoded http(s) URLs
 * and verifies each one resolves (returns a non-4xx/5xx HTTP status).
 *
 * URLs whose host is localhost, loopback, link-local, private or otherwise
 * internal (also after DNS resolution) are skipped and reported, never
 * requested. Plain http: URLs are still checked but flagged with a warning.
 *
 * Usage:
 *   node .github/skills/check-urls/check-urls.js
 *
 * Exit codes:
 *   0 — all URLs resolved successfully (2xx or 3xx)
 *   1 — one or more URLs are broken (4xx / 5xx / timeout / connection error)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const dns = require('dns');
const net = require('net');

// ── Configuration ──────────────────────────────────────────────────────────

const SRC_DIR = path.join(__dirname, '../../../src');
const TIMEOUT_MS = 10_000;

/**
 * URL prefixes that are intentionally not real HTTP endpoints and should be
 * skipped (e.g. JSON Schema meta-schemas). Internal hosts such as localhost
 * are handled by getInternalHostReason() instead.
 */
const SKIP_PREFIXES = [
    'http://json-schema.org/',
];

/**
 * HEAD statuses that suggest the server does not handle HEAD properly and are
 * worth a GET retry. Any other 4xx/5xx is taken at face value, so a URL that
 * already answered HEAD with a real error is never fetched with GET.
 */
const HEAD_RETRY_STATUSES = new Set([403, 405, 501]);

/** Address ranges that are never requested: [network, prefixLength, family, label]. */
const BLOCKED_RANGES = [
    ['0.0.0.0', 8, 'ipv4', 'unspecified'],
    ['10.0.0.0', 8, 'ipv4', 'private'],
    ['100.64.0.0', 10, 'ipv4', 'carrier-grade NAT'],
    ['127.0.0.0', 8, 'ipv4', 'loopback'],
    ['169.254.0.0', 16, 'ipv4', 'link-local'],
    ['172.16.0.0', 12, 'ipv4', 'private'],
    ['192.168.0.0', 16, 'ipv4', 'private'],
    ['::', 128, 'ipv6', 'unspecified'],
    ['::1', 128, 'ipv6', 'loopback'],
    ['fc00::', 7, 'ipv6', 'private'],
    ['fe80::', 10, 'ipv6', 'link-local'],
].map(([network, prefix, family, label]) => {
    const list = new net.BlockList();
    list.addSubnet(network, prefix, family);
    return { list, family, label };
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Recursively collect all *.ts files under a directory. */
function collectTsFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectTsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            results.push(full);
        }
    }
    return results;
}

/** Extract all unique http(s) URLs from a string. */
function extractUrls(text) {
    // Match URLs, then strip trailing punctuation that isn't part of the URL.
    // A bracketed IPv6 host (http://[::1]/) is matched as a unit so its closing
    // bracket survives both the character class and the trailing-punctuation strip.
    const raw = text.matchAll(/(https?:\/\/(?:\[[0-9A-Fa-f:.]+\])?)([^\s"'`<>)\]},]*)/g);
    const urls = new Set();
    for (const [, prefix, rest] of raw) {
        // Strip trailing punctuation characters that commonly appear after URLs
        // in prose or markdown (e.g. "see https://example.com." or "(https://example.com)")
        const url = prefix + rest.replace(/[.,;:!?)>\]'"`]+$/u, '');
        if (/^https?:\/\/$/i.test(url)) { continue; }
        // Skip template literal interpolations (e.g. https://${variable}/path)
        if (url.includes('${')) { continue; }
        urls.add(url);
    }
    return urls;
}

/** True when a URL uses the unencrypted http: scheme. */
function isPlainHttp(urlStr) {
    return /^http:\/\//i.test(urlStr);
}

/** Strip the brackets URL.hostname keeps around IPv6 literals. */
function unbracket(hostname) {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * If an IPv6 address is IPv4-mapped (::ffff:a.b.c.d, or the ::ffff:XXXX:XXXX
 * form that URL parsing normalises it to), return the embedded IPv4 address.
 */
function mappedIpv4(address) {
    const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
    if (!m) { return null; }
    if (m[1]) { return m[1]; }
    const hi = parseInt(m[2], 16);
    const lo = parseInt(m[3], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** Return why an IP address is internal (e.g. 'private'), or null if it is public or not an IP. */
function getInternalAddressReason(address) {
    const ip = unbracket(address);
    const version = net.isIP(ip);
    if (version === 0) { return null; }
    const v4 = version === 6 ? mappedIpv4(ip) : null;
    if (v4) { return getInternalAddressReason(v4); }
    const family = version === 4 ? 'ipv4' : 'ipv6';
    const match = BLOCKED_RANGES.find((r) => r.family === family && r.list.check(ip, family));
    return match ? match.label : null;
}

/**
 * Return why a URL hostname is internal without resolving it: 'localhost' for
 * localhost names, a range label for internal IP literals, otherwise null.
 */
function getInternalHostReason(hostname) {
    const host = unbracket(hostname).toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) { return 'localhost'; }
    return getInternalAddressReason(host);
}

/**
 * Resolve a hostname and return why it is internal (any resolved address in a
 * blocked range), or null. A failed lookup returns null: the request itself
 * will then fail and be reported as broken.
 */
async function getResolvedInternalReason(hostname, lookup = dns.promises.lookup) {
    const host = unbracket(hostname);
    if (net.isIP(host)) { return getInternalAddressReason(host); }
    let addresses;
    try {
        addresses = await lookup(host, { all: true });
    } catch {
        return null;
    }
    for (const { address } of addresses) {
        const reason = getInternalAddressReason(address);
        if (reason) { return `${reason} (${host} resolves to ${address})`; }
    }
    return null;
}

/**
 * dns.lookup replacement passed to http(s).request: refuses to hand back an
 * internal address, so a DNS answer that changes between the pre-check and the
 * connection (DNS rebinding) still cannot reach an internal host.
 */
function guardedLookup(hostname, options, callback, lookup = dns.lookup) {
    lookup(unbracket(hostname), options, (err, address, family) => {
        if (err) { callback(err); return; }
        const entries = Array.isArray(address) ? address : [{ address, family }];
        for (const entry of entries) {
            const reason = getInternalAddressReason(entry.address);
            if (reason) {
                callback(new Error(`blocked ${reason} address ${entry.address}`));
                return;
            }
        }
        callback(null, address, family);
    });
}

/** Send an HTTP HEAD request; retry with GET only when the HEAD status
 *  suggests the server does not support HEAD (see HEAD_RETRY_STATUSES). */
function checkUrl(urlStr, request = checkUrlWithMethod) {
    return request(urlStr, 'HEAD').then(({ status, error }) => {
        if (HEAD_RETRY_STATUSES.has(status)) {
            return request(urlStr, 'GET');
        }
        return { status, error };
    });
}

/** Send an HTTP request with the given method and resolve with { status, error }. */
function checkUrlWithMethod(urlStr, method) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(urlStr);
        } catch {
            resolve({ status: null, error: 'invalid URL' });
            return;
        }

        // URL.hostname keeps IPv6 literals bracketed; Node needs the bare address
        // to connect directly instead of handing "[::1]" to DNS. IP literals skip
        // the lookup hook entirely, so they are classified here instead.
        const hostname = unbracket(url.hostname);
        const internal = getInternalHostReason(hostname);
        if (internal) {
            resolve({ status: null, error: `blocked ${internal} host ${hostname}` });
            return;
        }

        const lib = url.protocol === 'https:' ? https : http;
        const options = {
            method,
            hostname,
            port: url.port || undefined,
            path: url.pathname + url.search,
            headers: {
                'User-Agent': 'copilot-token-tracker-url-checker/1.0',
            },
            timeout: TIMEOUT_MS,
            lookup: guardedLookup,
        };

        const req = lib.request(options, (res) => {
            resolve({ status: res.statusCode });
            req.destroy(); // don't wait for body
            res.resume();
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ status: null, error: 'timeout' });
        });

        req.on('error', (err) => {
            resolve({ status: null, error: err.message });
        });

        req.end();
    });
}

/**
 * Split URLs into those to request and those skipped because their host is
 * internal (literally or after DNS resolution). Invalid URLs are kept so the
 * request step reports them as broken.
 */
async function partitionInternalUrls(urls, lookup = dns.promises.lookup) {
    const toCheck = [];
    const skipped = [];
    for (const url of urls) {
        let hostname;
        try {
            hostname = new URL(url).hostname;
        } catch {
            toCheck.push(url);
            continue;
        }
        const reason = getInternalHostReason(hostname) || await getResolvedInternalReason(hostname, lookup);
        if (reason) {
            skipped.push({ url, reason });
        } else {
            toCheck.push(url);
        }
    }
    return { toCheck, skipped };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    // 1. Collect all TypeScript files
    if (!fs.existsSync(SRC_DIR)) {
        console.error(`❌ Source directory not found: ${SRC_DIR}`);
        process.exit(1);
    }

    const tsFiles = collectTsFiles(SRC_DIR);
    console.log(`Scanning ${tsFiles.length} TypeScript file(s) under ${path.relative(process.cwd(), SRC_DIR)}/\n`);

    // 2. Extract all URLs, tracking which file(s) each came from
    const urlSources = new Map(); // url → Set<relativePath>
    for (const file of tsFiles) {
        const content = fs.readFileSync(file, 'utf8');
        const rel = path.relative(process.cwd(), file);
        for (const url of extractUrls(content)) {
            if (!urlSources.has(url)) {
                urlSources.set(url, new Set());
            }
            urlSources.get(url).add(rel);
        }
    }

    // 3. Filter out known-skip prefixes and internal hosts
    const candidates = [...urlSources.keys()].filter(
        (u) => !SKIP_PREFIXES.some((prefix) => u.startsWith(prefix))
    );
    const { toCheck: urlsToCheck, skipped } = await partitionInternalUrls(candidates);

    for (const { url, reason } of skipped.sort((a, b) => a.url.localeCompare(b.url))) {
        console.log(`⏭️  SKIPPED [internal host: ${reason}]`);
        console.log(`          ${url}`);
        console.log(`          → ${[...urlSources.get(url)].join(', ')}\n`);
    }

    if (urlsToCheck.length === 0) {
        console.log('No URLs found to check.');
        process.exit(0);
    }

    console.log(`Found ${urlsToCheck.length} unique URL(s) to check.\n`);

    // 4. Check each URL
    let broken = 0;
    let insecure = 0;

    // Check sequentially to avoid hammering servers
    for (const url of urlsToCheck.sort()) {
        const sources = [...urlSources.get(url)].join(', ');
        const { status, error } = await checkUrl(url);

        if (isPlainHttp(url)) {
            console.log('⚠️  INSECURE [plain http:] consider switching to https:');
            console.log(`          ${url}`);
            console.log(`          → ${sources}`);
            insecure++;
        }

        if (error) {
            console.log(`❌ BROKEN  [${error}]`);
            console.log(`          ${url}`);
            console.log(`          → ${sources}\n`);
            broken++;
        } else if (status >= 400) {
            console.log(`❌ BROKEN  [HTTP ${status}]`);
            console.log(`          ${url}`);
            console.log(`          → ${sources}\n`);
            broken++;
        } else if (status >= 300) {
            console.log(`⚠️  REDIRECT [HTTP ${status}]`);
            console.log(`          ${url}`);
            console.log(`          → ${sources}\n`);
        } else {
            console.log(`✅ OK      [HTTP ${status}]  ${url}`);
        }
    }

    // 5. Summary
    console.log('\n─────────────────────────────────────────');
    if (skipped.length > 0) {
        console.log(`⏭️  ${skipped.length} URL(s) skipped because they point at an internal host.`);
    }
    if (insecure > 0) {
        console.log(`⚠️  ${insecure} URL(s) use plain http:.`);
    }
    if (broken === 0) {
        console.log(`✅ All ${urlsToCheck.length} URL(s) resolved successfully.`);
    } else {
        console.log(`❌ ${broken} of ${urlsToCheck.length} URL(s) are broken.`);
        process.exit(1);
    }
}

module.exports = {
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
};

if (require.main === module) {
    main().catch((err) => {
        console.error('Unexpected error:', err);
        process.exit(1);
    });
}
