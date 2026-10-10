import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

const SECURITY_HEADERS = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // The Copilot app injects its theme (CSS variables + palette) as inline <style> elements, so inline styles must be
    // allowed for the canvas to follow the app theme. Scripts stay same-origin only.
    "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
};

function send(res, status, contentType, body) {
    res.writeHead(status, { "Content-Type": contentType, ...SECURITY_HEADERS });
    res.end(body);
}

const json = (res, status, value) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

function hasPrefix(pathname, prefix) {
    const candidate = Buffer.from(pathname.slice(0, prefix.length));
    const expected = Buffer.from(prefix);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/**
 * Loopback-only server for one canvas panel. `refresher` is shared across
 * panels; the server only reads its state and asks it to refresh.
 *
 * Any local process can connect to a loopback port, so every route (page, assets, state, events, refresh) lives under
 * an unguessable per-panel path. Only the canvas gets it, through the URL returned here; requests without it get 404.
 */
export async function startServer({ refresher, keepAliveMs = 25_000, port = 0 }) {
    const base = `/${randomBytes(32).toString("base64url")}/`;
    const clients = new Set();
    const broadcast = (state) => {
        const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
        for (const res of clients) res.write(frame);
    };

    const server = createServer((req, res) => {
        void (async () => {
            const origin = `http://127.0.0.1:${server.address().port}`;
            if (req.headers.host !== origin.slice("http://".length)) {
                send(res, 403, "text/plain; charset=utf-8", "Invalid host");
                return;
            }
            const pathname = new URL(req.url, origin).pathname;
            if (!hasPrefix(pathname, base)) {
                if (hasPrefix(`${pathname}/`, base) && pathname.length === base.length - 1) {
                    res.writeHead(308, { Location: base, ...SECURITY_HEADERS });
                    res.end();
                } else {
                    send(res, 404, "text/plain; charset=utf-8", "Not found");
                }
                return;
            }
            const path = pathname.slice(base.length - 1);
            if (req.method === "POST" && path === "/api/refresh") {
                if (req.headers.origin !== origin) {
                    send(res, 403, "text/plain; charset=utf-8", "Invalid origin");
                    return;
                }
                void refresher.refresh();
                json(res, 202, refresher.state().status);
                return;
            }
            if (req.method !== "GET") {
                res.setHeader("Allow", "GET");
                send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
                return;
            }
            if (path === "/api/state") {
                await refresher.load();
                json(res, 200, refresher.state());
            } else if (path === "/events") {
                let gone = false;
                res.on("close", () => {
                    gone = true;
                    clients.delete(res);
                });
                // Load first: `open()` starts a refresh without waiting, so the snapshot may not be read yet, and a
                // snapshot that is already fresh emits no later change to correct an initial `snapshot: null`.
                await refresher.load();
                if (gone) return;
                res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", ...SECURITY_HEADERS });
                res.write(`event: state\ndata: ${JSON.stringify(refresher.state())}\n\n`);
                clients.add(res);
            } else if (assets.has(path)) {
                const [file, contentType] = assets.get(path);
                send(res, 200, contentType, await readFile(new URL(`./assets/${file}`, import.meta.url)));
            } else {
                send(res, 404, "text/plain; charset=utf-8", "Not found");
            }
        })().catch((error) => {
            if (!res.headersSent) json(res, 500, { error: error.message });
            else res.end();
        });
    });
    // Bind first: if the port cannot be opened, nothing below has been set up yet, so there is nothing to leak.
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    refresher.on("change", broadcast);
    const keepAlive = setInterval(() => {
        for (const res of clients) res.write(": keep-alive\n\n");
    }, keepAliveMs);
    keepAlive.unref?.();
    server.on("close", () => {
        clearInterval(keepAlive);
        refresher.off("change", broadcast);
        for (const res of clients) res.end();
        clients.clear();
    });
    const close = () =>
        new Promise((resolve) => {
            for (const res of clients) res.end();
            server.close(() => resolve());
            server.closeAllConnections?.();
        });
    return { server, close, url: `http://127.0.0.1:${server.address().port}${base}` };
}
