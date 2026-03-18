#!/usr/bin/env node

/**
 * URL Resolution Check Script
 *
 * Scans all TypeScript source files under src/ for hardcoded http(s) URLs
 * and verifies each one resolves (returns a non-4xx/5xx HTTP status).
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

// ── Configuration ──────────────────────────────────────────────────────────

const SRC_DIR = path.join(__dirname, '../../../src');
const TIMEOUT_MS = 10_000;

/**
 * URL prefixes that are intentionally not real HTTP endpoints and should be
 * skipped (e.g. JSON Schema meta-schemas, localhost references).
 */
const SKIP_PREFIXES = [
    'http://json-schema.org/',
    'http://localhost',
    'https://localhost',
];

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
    // Match URLs, then strip trailing punctuation that isn't part of the URL
    const raw = text.matchAll(/https?:\/\/[^\s"'`<>)\]},]+/g);
    const urls = new Set();
    for (const [match] of raw) {
        // Strip trailing punctuation characters that commonly appear after URLs
        // in prose or markdown (e.g. "see https://example.com." or "(https://example.com)")
        const url = match.replace(/[.,;:!?)>\]'"`]+$/u, '');
        // Skip template literal interpolations (e.g. https://${variable}/path)
        if (url.includes('${')) { continue; }
        urls.add(url);
    }
    return urls;
}

/** Send an HTTP HEAD request; fall back to GET if the server returns a 4xx.
 *  Some servers (e.g. bsky.app intent URLs) return 404 or 405 for HEAD but
 *  correctly serve GET requests, so any 4xx HEAD response triggers a retry. */
function checkUrl(urlStr) {
    return checkUrlWithMethod(urlStr, 'HEAD').then(({ status, error }) => {
        if (status >= 400) {
            // Server may not support HEAD — retry with GET
            return checkUrlWithMethod(urlStr, 'GET');
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

        const lib = url.protocol === 'https:' ? https : http;
        const options = {
            method,
            hostname: url.hostname,
            port: url.port || undefined,
            path: url.pathname + url.search,
            headers: {
                'User-Agent': 'copilot-token-tracker-url-checker/1.0',
            },
            timeout: TIMEOUT_MS,
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

    // 3. Filter out known-skip prefixes
    const urlsToCheck = [...urlSources.keys()].filter(
        (u) => !SKIP_PREFIXES.some((prefix) => u.startsWith(prefix))
    );

    if (urlsToCheck.length === 0) {
        console.log('No URLs found to check.');
        process.exit(0);
    }

    console.log(`Found ${urlsToCheck.length} unique URL(s) to check.\n`);

    // 4. Check each URL
    let broken = 0;

    // Check sequentially to avoid hammering servers
    for (const url of urlsToCheck.sort()) {
        const sources = [...urlSources.get(url)].join(', ');
        const { status, error } = await checkUrl(url);

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
    if (broken === 0) {
        console.log(`✅ All ${urlsToCheck.length} URL(s) resolved successfully.`);
    } else {
        console.log(`❌ ${broken} of ${urlsToCheck.length} URL(s) are broken.`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
