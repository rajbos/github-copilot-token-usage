import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import { test } from "node:test";
import { startServer } from "../server.mjs";

function fakeRefresher() {
    const refresher = new EventEmitter();
    refresher.refreshes = 0;
    refresher.current = { snapshot: { fetchedAt: "2026-01-01T00:00:00.000Z" }, status: { state: "idle" } };
    refresher.load = async () => refresher.current.snapshot;
    refresher.state = () => refresher.current;
    refresher.refresh = () => {
        refresher.refreshes++;
        refresher.current = { ...refresher.current, status: { state: "running" } };
        return Promise.resolve(refresher.current);
    };
    return refresher;
}

function rawRequest(url, { method = "GET", headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = request(url, { method, headers }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
    });
}

test("serves assets and state with a strict CSP", async (t) => {
    const refresher = fakeRefresher();
    const { close, url } = await startServer({ refresher });
    t.after(close);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>AI Engineering Fluency<\/title>/);
    assert.match(
        html,
        /<a href="https:\/\/github\.com\/rajbos\/ai-engineering-fluency" target="_blank" rel="noopener noreferrer">/,
        "the footer links back to the repository, opening outside the canvas",
    );
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self';/, "scripts must stay same-origin only");
    assert.match(csp, /style-src 'self' 'unsafe-inline'/, "the app injects its theme as inline <style> elements");
    for (const asset of ["app.js", "style.css"]) assert.equal((await fetch(new URL(asset, url))).status, 200);
    const state = await (await fetch(new URL("api/state", url))).json();
    assert.equal(state.snapshot.fetchedAt, "2026-01-01T00:00:00.000Z");
    assert.equal((await fetch(new URL("nope", url))).status, 404);
    assert.equal((await fetch(new URL("api/state", url), { method: "PUT" })).status, 405);
});

test("rejects foreign Host headers (DNS rebinding) and cross-origin refresh posts", async (t) => {
    const refresher = fakeRefresher();
    const { close, url } = await startServer({ refresher });
    t.after(close);
    assert.equal((await rawRequest(new URL("api/state", url), { headers: { Host: "evil.example" } })).status, 403);
    const crossOrigin = await rawRequest(new URL("api/refresh", url), { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await rawRequest(new URL("api/refresh", url), { method: "POST" })).status, 403, "missing Origin is rejected");
    assert.equal(refresher.refreshes, 0);

    const ok = await rawRequest(new URL("api/refresh", url), { method: "POST", headers: { Origin: new URL(url).origin } });
    assert.equal(ok.status, 202);
    assert.deepEqual(JSON.parse(ok.body), { state: "running" });
    assert.equal(refresher.refreshes, 1);
});

test("every route requires the panel's private path", async (t) => {
    const refresher = fakeRefresher();
    const { close, url } = await startServer({ refresher });
    t.after(close);
    const { origin, pathname } = new URL(url);
    assert.match(pathname, /^\/[\w-]{43}\/$/, "a 256-bit URL-safe key");
    const page = await (await fetch(url)).text();
    assert.match(page, /href="style\.css"/, "assets load relative to the private path");
    assert.match(page, /src="app\.js"/);

    const wrongKey = `/${"A".repeat(43)}/`;
    for (const prefix of ["/", wrongKey]) {
        for (const route of ["", "app.js", "api/state", "events"]) {
            const res = await rawRequest(`${origin}${prefix}${route}`);
            assert.equal(res.status, 404, `${prefix}${route}`);
            assert.doesNotMatch(res.body, /fetchedAt|AI Engineering Fluency/);
        }
        const post = await rawRequest(`${origin}${prefix}api/refresh`, { method: "POST", headers: { Origin: origin } });
        assert.equal(post.status, 404);
    }
    assert.equal(refresher.refreshes, 0);

    const redirect = await rawRequest(`${origin}${pathname.slice(0, -1)}`);
    assert.equal(redirect.status, 308, "the key without its trailing slash redirects to the canonical path");
    assert.equal(redirect.headers.location, pathname);

    const other = await startServer({ refresher });
    t.after(other.close);
    assert.notEqual(new URL(other.url).pathname, pathname, "each panel gets its own key");
    assert.equal((await rawRequest(`${new URL(other.url).origin}${pathname}api/state`)).status, 404);
});

test("streams state changes over server-sent events", async (t) => {
    const refresher = fakeRefresher();
    const { close, url } = await startServer({ refresher });
    t.after(close);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const res = await fetch(new URL("events", url), { signal: controller.signal });
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern) => {
        while (!pattern.test(text)) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value);
        }
    };
    await readUntil(/"state":"idle"/);
    refresher.emit("change", { snapshot: null, status: { state: "running" } });
    await readUntil(/"state":"running"/);
    assert.match(text, /event: state/);
});

test("the first event carries the snapshot even when the disk read is still in progress", async (t) => {
    const refresher = fakeRefresher();
    const snapshot = refresher.current.snapshot;
    refresher.current = { snapshot: null, status: { state: "idle" } };
    refresher.load = () =>
        new Promise((resolve) =>
            setTimeout(() => {
                refresher.current = { ...refresher.current, snapshot };
                resolve(snapshot);
            }, 30),
        );
    const { close, url } = await startServer({ refresher });
    t.after(close);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const res = await fetch(new URL("events", url), { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!/\n\n/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
    }
    const first = JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6));
    assert.equal(first.snapshot?.fetchedAt, "2026-01-01T00:00:00.000Z");
});

test("a port that cannot be bound fails cleanly without subscribing to the refresher", async (t) => {
    const refresher = fakeRefresher();
    const busy = createServer();
    await new Promise((resolve) => busy.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => busy.close(resolve)));
    await assert.rejects(startServer({ refresher, port: busy.address().port }), { code: "EADDRINUSE" });
    assert.equal(refresher.listenerCount("change"), 0, "no listener or keep-alive timer is left behind");
});