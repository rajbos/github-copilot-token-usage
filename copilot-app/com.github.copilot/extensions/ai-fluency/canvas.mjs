// The canvas registration, kept free of `@github/copilot-sdk/extension` imports so it can be tested with a stub SDK.
// extension.mjs passes the real SDK in.

import { Panels } from "./panels.mjs";
import { OPEN_REFRESH_MIN_AGE_MS, Refresher } from "./refresher.mjs";
import { startServer } from "./server.mjs";
import { summarize } from "./store.mjs";

export const CANVAS_ID = "ai-fluency";
export const DISPLAY_NAME = "AI Engineering Fluency";

/** The canvas definition handed to the SDK's `createCanvas()`. */
export function fluencyCanvas({ refresher, panels, CanvasError }) {
    return {
        id: CANVAS_ID,
        displayName: DISPLAY_NAME,
        description:
            "Your AI Engineering Fluency stats across AI tools: token usage, cost, recent sessions, and fluency score (read from local session logs).",
        inputSchema: { type: ["object", "null"], additionalProperties: false },
        actions: [
            {
                name: "get_summary",
                description:
                    "Return the latest cached stats: per-period tokens/sessions/cost/CO2, top models, editors and fluency stages with tips. Does not run the CLI. " +
                    "Session titles (often the user's first prompt) and project names are only included when topSessions > 0 — request them only when the user asks about specific sessions.",
                inputSchema: {
                    type: ["object", "null"],
                    properties: {
                        topSessions: {
                            type: "integer",
                            minimum: 0,
                            maximum: 25,
                            description: "Number of top sessions of the last 7 days (by tokens) to include, with their titles and project names. Default 0.",
                        },
                    },
                    additionalProperties: false,
                },
                handler: async ({ input }) => {
                    const snapshot = await refresher.load();
                    const { status } = refresher.state();
                    return { ...summarize(snapshot, { topSessions: input?.topSessions ?? 0 }), refresh: status };
                },
            },
            {
                name: "refresh",
                description:
                    "Re-run the CLI in the background to refresh the stats (takes several minutes). Returns as soon as the refresh has begun: started=true when it runs in this session, " +
                    "started=false with status.byOtherSession when another Copilot session is already running one (its result is picked up here). Fails at once when it cannot start. " +
                    "Set wait=true to block until it finishes instead (including a refresh another Copilot session is already running).",
                inputSchema: {
                    type: ["object", "null"],
                    properties: { wait: { type: "boolean" } },
                    additionalProperties: false,
                },
                handler: async ({ input }) => {
                    if (refresher.disposed) throw new CanvasError("refresh_failed", `The ${DISPLAY_NAME} extension is shutting down; try again in a new session.`);
                    if (!input?.wait) {
                        const { status, snapshot } = await refresher.startRefresh();
                        if (status.state === "error") throw new CanvasError("refresh_failed", status.error);
                        if (status.state !== "running") return { started: false, status, fetchedAt: snapshot?.fetchedAt ?? null };
                        if (status.byOtherSession) {
                            return {
                                started: false,
                                status,
                                message: "Another Copilot session is already refreshing the stats (several minutes); this canvas picks up its result. Call get_summary afterwards.",
                            };
                        }
                        return { started: true, status, message: "Refresh is running in the background (several minutes). The canvas updates when it finishes; call get_summary afterwards." };
                    }
                    let { status, snapshot } = await refresher.refresh();
                    if (status.state === "running" && status.byOtherSession) ({ status, snapshot } = await refresher.waitForOtherSession());
                    if (status.state === "error") throw new CanvasError("refresh_failed", status.error);
                    if (status.state === "running") {
                        return { status, fetchedAt: snapshot?.fetchedAt ?? null, message: "Another Copilot session's refresh is still running; call get_summary later." };
                    }
                    return { status, fetchedAt: snapshot?.fetchedAt ?? null };
                },
            },
        ],
        open: async ({ instanceId }) => {
            const entry = await panels.open(instanceId);
            refresher.background(() => refresher.maybeRefresh(OPEN_REFRESH_MIN_AGE_MS));
            return { title: DISPLAY_NAME, url: entry.url };
        },
        onClose: ({ instanceId }) => panels.close(instanceId),
    };
}

/**
 * Joins the Copilot session with the canvas registered, and stops the panels and any CLI run on SIGTERM/SIGINT.
 * `sdk` provides `{ createCanvas, CanvasError, joinSession }` from `@github/copilot-sdk/extension`.
 */
export async function startExtension(sdk, { refresher = new Refresher(), start = startServer, processRef = process } = {}) {
    const panels = new Panels({
        start: () => start({ refresher }),
        acquire: () => refresher.acquire(),
        release: () => refresher.release(),
    });
    let session;
    refresher.on("change", ({ status }) => {
        if (status.state === "error") {
            void session?.log(`${DISPLAY_NAME} refresh failed: ${status.error}`, { level: "warning", ephemeral: true });
        }
    });
    const shutdown = async () => {
        await panels.closeAll();
        await refresher.dispose();
    };
    processRef.once("SIGTERM", () => void shutdown().finally(() => processRef.exit(0)));
    processRef.once("SIGINT", () => void shutdown().finally(() => processRef.exit(0)));

    const canvas = sdk.createCanvas(fluencyCanvas({ refresher, panels, CanvasError: sdk.CanvasError }));
    session = await sdk.joinSession({ canvases: [canvas] });
    return { session, panels, refresher, shutdown };
}
