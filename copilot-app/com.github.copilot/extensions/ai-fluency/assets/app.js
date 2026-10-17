"use strict";

// Stage names, descriptions, view titles and icons mirror the AI Engineering Fluency VS Code extension.
const STAGE_NAMES = { 1: "AI Skeptic", 2: "AI Explorer", 3: "AI Collaborator", 4: "AI Strategist" };
const STAGE_DESCRIPTIONS = {
    1: "Rarely uses AI tools or uses only basic features",
    2: "Exploring AI capabilities with occasional use",
    3: "Regular, purposeful use across multiple features",
    4: "Strategic, advanced use leveraging the full AI ecosystem",
};
const VIEWS = {
    overview: ["🤖", "AI Token Usage"],
    chart: ["📈", "Token Usage"],
    sessions: ["📂", "Sessions"],
    fluency: ["🎯", "AI Engineering Fluency Score"],
};
const TABS = Object.keys(VIEWS);
const EDITOR_ICONS = {
    Antigravity: "🚀", "Claude Code": "🟠", "Claude Code CLI": "🟠", "Claude Desktop": "🟠", "Claude Desktop Cowork": "🟠", Cline: "🤖",
    "Codex CLI": "🌀", Continue: "▶️", "Copilot CLI": "🤖", "Copilot CLI (App)": "🤖", Crush: "🦾", Cursor: "🖱️", Devin: "🧠", "Devin CLI": "🧠",
    Eclipse: "🌑", "Gemini CLI": "💎", Hermes: "🪽", JetBrains: "🧩", "Kilo Code": "🟣", Kiro: "👻", "Kiro CLI": "👻", "Mistral Vibe": "🔥",
    OpenCode: "🟢", Pi: "π", SSMS: "🗄️", "Visual Studio": "🪟", "VS Code": "💙", "VS Code Insiders": "💚", "VS Code Server": "☁️", VSCodium: "🔷", Windsurf: "🏄",
};
const editorIcon = (name) => EDITOR_ICONS[name] ?? "📝";
const PERIODS = [
    ["today", "Today"],
    ["last30Days", "30 days"],
    ["month", "This month"],
    ["lastMonth", "Last month"],
];
const COLUMNS = [
    ["today", "📅", "Today"],
    ["last30Days", "📈", "Last 30 Days"],
    ["month", "🗓️", "Current Month"],
    ["lastMonth", "📆", "Previous Month"],
    ["projected", "🌍", "Projected Year"],
];
// Narrow panels show one stats column at a time, so the picker offers every column, including the projection.
const COLUMN_PICKER = [...PERIODS, ["projected", "Projected year"]];
const PROJECT = 365 / 30;
const RANGES = [
    ["today", "Today"],
    ["7d", "7 days"],
    ["30d", "30 days"],
];
const SORTS = [
    ["recent", "Most recent"],
    ["tokens", "Most tokens"],
    ["cost", "Highest cost"],
];
const PAGE = 40;
// Chart view controls and labels mirror the extension's Chart webview.
const CHART_PERIODS = [
    ["day", "Day"],
    ["week", "Week"],
    ["month", "Month"],
];
const METRICS = [
    ["tokens", "Tokens"],
    ["cost", "💰 Cost"],
    ["sessions", "📊 Sessions"],
];
const SPLITS = [
    ["total", "Total"],
    ["model", "By Model"],
    ["editor", "By Editor"],
    ["provider", "🏷️ By Provider"],
    ["repository", "By Repository"],
];

const stored = (key, allowed, fallback) => {
    const value = localStorage.getItem(`ai-fluency.${key}`);
    return allowed.includes(value) ? value : fallback;
};
const storedFlag = (key) => localStorage.getItem(`ai-fluency.${key}`) === "true";
const PERSISTED = ["tab", "period", "range", "sort", "chartPeriod", "chartMetric", "chartSplit", "chartRolling", "editorCardsCollapsed"];
const ui = {
    tab: stored("tab", TABS, "overview"),
    period: stored("period", COLUMN_PICKER.map((p) => p[0]), "today"),
    range: stored("range", RANGES.map((r) => r[0]), "today"),
    sort: stored("sort", SORTS.map((s) => s[0]), "recent"),
    query: "",
    limit: PAGE,
    modelsExpanded: false,
    chartPeriod: stored("chartPeriod", CHART_PERIODS.map((p) => p[0]), "day"),
    chartMetric: stored("chartMetric", METRICS.map((m) => m[0]), "tokens"),
    chartSplit: stored("chartSplit", SPLITS.map((s) => s[0]), "total"),
    chartRolling: storedFlag("chartRolling"),
    editorCardsCollapsed: storedFlag("editorCardsCollapsed"),
    hiddenSeries: new Set(),
    openTips: new Set(),
};
let data = { snapshot: null, status: null };
const hashTab = location.hash.slice(1);
if (TABS.includes(hashTab)) ui.tab = hashTab;

// ---------- formatting ----------
const compactFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat();
const compact = (n) => compactFmt.format(n || 0);
const int = (n) => intFmt.format(Math.round(n || 0));
const usd = (n) => {
    const v = n || 0;
    if (v === 0) return "$0";
    if (v < 0.01) return "<$0.01";
    return `$${v >= 1000 ? intFmt.format(Math.round(v)) : v.toFixed(2)}`;
};
const grams = (g) => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${(g || 0).toFixed(g < 10 ? 2 : 0)} g`);
const liters = (l) => `${(l || 0).toFixed(l < 1 ? 3 : 2)} L`;
const minutes = (ms) => {
    const m = Math.round((ms || 0) / 60000);
    if (m < 1) return null;
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "unknown";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? "yesterday" : `${d}d ago`;
}
const elapsed = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const shortDate = (label) => {
    const d = new Date(`${label}T00:00:00`);
    return Number.isNaN(d.getTime()) ? label : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const pct = (part, whole) => `${whole > 0 ? ((part / whole) * 100).toFixed(1) : "0.0"}%`;

// The Copilot app marks the canvas root with `data-theme-tone` (and Primer-style `data-color-mode`) and injects its
// colour tokens; use those first, then the injected background's luminance, then the OS preference.
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const themeProbe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
function hostTone() {
    const els = [document.documentElement, document.body];
    for (const attr of ["data-theme-tone", "data-color-mode"]) {
        for (const el of els) {
            const value = el?.getAttribute(attr)?.toLowerCase() ?? "";
            if (value.includes("dark")) return "dark";
            if (value.includes("light")) return "light";
        }
    }
    const hostBg = getComputedStyle(document.documentElement).getPropertyValue("--background-color-default").trim();
    if (!hostBg) return null;
    themeProbe.clearRect(0, 0, 1, 1);
    themeProbe.fillStyle = "#fff";
    themeProbe.fillStyle = hostBg;
    themeProbe.fillRect(0, 0, 1, 1);
    const [r, g, b] = themeProbe.getImageData(0, 0, 1, 1).data;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
}
function syncTheme() {
    const theme = hostTone() ?? (darkQuery.matches ? "dark" : "light");
    if (document.documentElement.dataset.fluencyTheme !== theme) document.documentElement.dataset.fluencyTheme = theme;
}
syncTheme();
const themeObserver = new MutationObserver(syncTheme);
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-tone", "data-color-mode", "style"] });
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-theme-tone", "data-color-mode"] });
themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
darkQuery.addEventListener("change", syncTheme);

// ---------- DOM helpers (textContent only; data is never parsed as HTML) ----------
function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}
const svg = (tag, attrs = {}) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
};
/** Turns `[label](https://…)` in CLI tip text into anchors; everything else stays plain text. */
function linkify(text) {
    const parts = [];
    const re = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
    let last = 0;
    for (let m; (m = re.exec(text)); last = re.lastIndex) {
        parts.push(text.slice(last, m.index), h("a", { href: m[2], target: "_blank", rel: "noopener noreferrer" }, m[1]));
    }
    parts.push(text.slice(last));
    return parts;
}
function segmented(label, options, current, onPick) {
    return h(
        "div",
        { class: "segmented", role: "group", "aria-label": label },
        options.map(([value, text]) =>
            h("button", { type: "button", "data-key": `${label}:${value}`, "aria-pressed": String(value === current), onclick: () => onPick(value) }, text),
        ),
    );
}
const empty = (text) => h("div", { class: "empty" }, text);

// ---------- header + banner ----------
let bannerKey = null;

function tickHeader() {
    const { snapshot, status } = data;
    const subtitle = document.getElementById("subtitle");
    if (snapshot) {
        const version = snapshot.cliVersion ? ` · CLI v${snapshot.cliVersion}` : "";
        subtitle.textContent = `Updated ${ago(snapshot.fetchedAt)}${version}`;
        subtitle.title = new Date(snapshot.fetchedAt).toLocaleString();
    } else {
        subtitle.textContent = status ? "No data yet" : "Loading…";
    }
    const clock = document.getElementById("elapsed");
    if (clock && status?.startedAt) clock.textContent = elapsed(status.startedAt);
}

function renderHeader() {
    const { snapshot, status } = data;
    const running = status?.state === "running";
    const button = document.getElementById("refresh");
    button.disabled = running;
    document.getElementById("refresh-label").textContent = running ? "Refreshing…" : "Refresh";

    const key = JSON.stringify([status?.state, status?.startedAt, status?.error, status?.byOtherSession, Boolean(snapshot)]);
    if (key !== bannerKey) {
        bannerKey = key;
        const banner = document.getElementById("banner");
        banner.replaceChildren();
        banner.className = "banner";
        if (running) {
            const who = status.byOtherSession ? "Another Copilot session is refreshing" : "Refreshing";
            const firstRun = snapshot ? "" : " The first run reads every session log and can take several minutes.";
            banner.classList.add("running");
            banner.append(
                h("div", {}, `${who} — `, h("span", { id: "elapsed", class: "num" }), ` elapsed.${firstRun}`),
                h("div", { class: "progress", role: "progressbar", "aria-label": "Refreshing" }),
            );
            banner.hidden = false;
        } else if (status?.state === "error") {
            banner.classList.add("error");
            banner.append(h("div", {}, `Last refresh failed ${ago(status.finishedAt)}: ${status.error}`));
            banner.hidden = false;
        } else {
            banner.hidden = true;
        }
    }
    tickHeader();
}

// ---------- details (overview) ----------
const PERIOD_KEYS = PERIODS.map(([key]) => key);
const FLUENCY_DOCS = "https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/FLUENCY-LEVELS.md";
const sum = (values) => values.reduce((a, b) => a + (b || 0), 0);

function section(heading, ...children) {
    return h("div", { class: "section" }, heading && h("h3", {}, heading), ...children);
}

let tipIds = 0;

/** A row's label; an explanation sits behind a real button so keyboard, touch and screen-reader users can open it. */
function rowLabel(row) {
    const icon = row.icon && h("span", { "aria-hidden": "true" }, row.icon);
    if (!row.tip) return h("span", { class: "metric-label" }, icon, h("span", {}, row.label));
    const open = ui.openTips.has(row.label);
    const id = `metric-tip-${++tipIds}`;
    const toggle = () => {
        if (open) ui.openTips.delete(row.label);
        else ui.openTips.add(row.label);
        renderPanel();
    };
    return [
        h(
            "span",
            { class: "metric-label" },
            icon,
            h("span", {}, row.label),
            h("button", { type: "button", class: "hint-button", title: row.tip, "aria-label": `About ${row.label}`, "aria-expanded": String(open), "aria-controls": id, "data-key": `tip:${row.label}`, onclick: toggle }, "ℹ️"),
        ),
        h("div", { class: "muted hint-text", id, hidden: !open }, row.tip),
    ];
}

/**
 * Extension-style stats table. On narrow panels CSS shows only the selected period's column (`.sel`). Each group is its
 * own `tbody` headed by a row-group header, and each row's label is a row header, so screen readers can name a number.
 */
function statsTable(firstHeader, groups) {
    const cell = (tag, key, ...children) => h(tag, { class: `align-right${key === ui.period ? " sel" : ""}`, "data-col": key, scope: tag === "th" ? "col" : null }, ...children);
    const bodies = groups.map((group) =>
        h(
            "tbody",
            {},
            group.heading && h("tr", { class: "group-row" }, h("th", { scope: "rowgroup" }, group.heading), COLUMNS.map(([key]) => cell("td", key))),
            group.rows.map((row) =>
                h(
                    "tr",
                    {},
                    h("th", { scope: "row" }, rowLabel(row)),
                    COLUMNS.map(([key]) => {
                        const value = row.cells[key];
                        return cell("td", key, value?.main ?? "—", value?.sub && h("div", { class: "muted" }, value.sub));
                    }),
                ),
            ),
        ),
    );
    const head = h("thead", {}, h("tr", {}, h("th", { scope: "col" }, firstHeader), COLUMNS.map(([key, icon, label]) => cell("th", key, `${icon} ${label}`))));
    return h("table", { class: "stats-table num" }, head, bodies);
}

function metricGroups(periods) {
    const row = (icon, label, value, project, tip) => ({
        icon,
        label,
        tip,
        cells: { ...Object.fromEntries(PERIOD_KEYS.map((k) => [k, { main: value(periods[k]) }])), projected: project ? { main: project(periods.last30Days) } : null },
    });
    const modelSum = (p, field) => sum(p.models.map((m) => m[field]));
    return [
        {
            heading: "🔢 Tokens",
            rows: [
                row("🟣", "Total tokens", (p) => compact(p.tokens), (p) => compact(p.tokens * PROJECT)),
                row("⬆️", "Input tokens", (p) => compact(modelSum(p, "inputTokens"))),
                row("⬇️", "Output tokens", (p) => compact(modelSum(p, "outputTokens"))),
                row("🧠", "Thinking tokens", (p) => compact(p.thinkingTokens)),
            ],
        },
        {
            heading: "💰 Cost",
            rows: [
                row("💵", "Estimated cost (API list price)", (p) => usd(p.estimatedCost), (p) => usd(p.estimatedCost * PROJECT), "API-equivalent estimate at each provider's list prices."),
                row("🟢", "Estimated cost (Copilot UBB)", (p) => usd(p.estimatedCostCopilot), (p) => usd(p.estimatedCostCopilot * PROJECT), "GitHub Copilot AI Credit rates (1 credit = $0.01). UBB = usage-based billing."),
            ],
        },
        {
            heading: "💬 Activity",
            rows: [
                row("📂", "Sessions", (p) => int(p.sessions), (p) => int(p.sessions * PROJECT)),
                row("💬", "Average interactions/session", (p) => int(p.avgInteractionsPerSession)),
                row("🔢", "Average tokens/session", (p) => compact(p.avgTokensPerSession)),
            ],
        },
        {
            heading: "🌍 Environment",
            rows: [
                row("🌱", "Estimated CO₂", (p) => grams(p.co2), (p) => grams(p.co2 * PROJECT)),
                row("💧", "Estimated water", (p) => liters(p.waterUsage), (p) => liters(p.waterUsage * PROJECT)),
                row("🌳", "Tree equivalent (yr)", (p) => (p.treesEquivalent || 0).toFixed(3), (p) => ((p.treesEquivalent || 0) * PROJECT).toFixed(3)),
            ],
        },
    ];
}

/** Rows for the "Usage by Editor/Model" tables: one row per name seen in any period, sorted by the selected period. */
function usageRows(periods, kind) {
    const find = (key, name) => periods[key][kind].find((item) => item.name === name);
    const totals = Object.fromEntries(PERIOD_KEYS.map((k) => [k, sum(periods[k][kind].map((item) => item.tokens))]));
    const names = new Set(PERIOD_KEYS.flatMap((k) => periods[k][kind].filter((item) => item.tokens > 0).map((item) => item.name)));
    const sub = (item, total) => (kind === "editors" ? `${pct(item?.tokens || 0, total)} · ${int(item?.sessions)} sessions` : pct(item?.tokens || 0, total));
    // The projected year is extrapolated from the last 30 days, so it sorts like that column.
    const sortBy = ui.period === "projected" ? "last30Days" : ui.period;
    return [...names]
        .map((name) => {
            const last30 = find("last30Days", name);
            return {
                icon: kind === "editors" ? editorIcon(name) : null,
                label: name,
                order: [find(sortBy, name)?.tokens || 0, last30?.tokens || 0],
                cells: {
                    ...Object.fromEntries(PERIOD_KEYS.map((k) => [k, { main: compact(find(k, name)?.tokens || 0), sub: sub(find(k, name), totals[k]) }])),
                    projected: { main: compact((last30?.tokens || 0) * PROJECT), sub: kind === "editors" ? `${int((last30?.sessions || 0) * PROJECT)} sessions` : null },
                },
            };
        })
        .sort((a, b) => b.order[0] - a.order[0] || b.order[1] - a.order[1]);
}

function summaryCard(label, value, sub) {
    return h("div", { class: "card" }, h("div", { class: "card-label" }, label), h("div", { class: "card-value num" }, value), sub && h("div", { class: "card-sub num" }, sub));
}

function renderOverview(snapshot) {
    const { periods } = snapshot;
    const models = usageRows(periods, "models");
    const editors = usageRows(periods, "editors");
    const shownModels = ui.modelsExpanded ? models : models.slice(0, 8);
    return [
        h("div", { class: "period-picker" }, segmented("Period", COLUMN_PICKER, ui.period, (v) => update({ period: v }))),
        section("📊 Key Metrics", statsTable("📊 Metric", metricGroups(periods))),
        section("💻 Usage by Editor", editors.length ? statsTable("📝 Editor", [{ rows: editors }]) : empty("No editor activity yet.")),
        section(
            "🤖 Usage by Model",
            models.length ? statsTable("🧩 Model", [{ rows: shownModels }]) : empty("No model usage yet."),
            models.length > 8 &&
                h("button", { type: "button", class: "link", "data-key": "more-models", onclick: () => update({ modelsExpanded: !ui.modelsExpanded }) }, ui.modelsExpanded ? "Show fewer" : `Show all ${models.length} models`),
        ),
    ];
}

// ---------- chart (the extension's Chart view: same controls, datasets and colours, drawn as SVG) ----------
const PALETTE = [[54, 162, 235], [255, 99, 132], [75, 192, 192], [153, 102, 255], [255, 159, 64], [255, 205, 86], [201, 203, 207], [100, 181, 246]];
const OTHER_RGB = [128, 128, 140];
const SERIES_RGB = { tokens: [54, 162, 235], sessions: [255, 99, 132], cost: [34, 197, 94], sessionBars: [137, 180, 250], projection: [200, 200, 200] };
const PERIOD_META = {
    day: { window: "Last 30 Days", unit: "day", count: "Total Days", footer: "Day-by-day token usage for the last 30 days", agg: "Aggregated by Day", rolling: 7, projected: "📈 Projected (today)" },
    week: { window: "Last 6 Weeks", unit: "week", count: "Total Weeks", footer: "Week-by-week token usage for the last 6 weeks", agg: "Aggregated by Week", rolling: 4, projected: "📈 Projected (this week)" },
    month: { window: "Last 12 Months", unit: "month", count: "Total Months", footer: "Monthly token usage for the last 12 months", agg: "Aggregated by Month", rolling: 3, projected: "📈 Projected (this month)" },
};
const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const money = (v) => `$${(v || 0).toFixed(2)}`;
const moneyTick = (v) => (v >= 1000 ? `$${compact(v)}` : `$${Number.isInteger(v) ? v : v.toFixed(2)}`);
const fx = (v) => Number(v.toFixed(1));
const longDate = (label) => {
    const d = new Date(`${label}T00:00:00`);
    return Number.isNaN(d.getTime()) ? label : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const rollingAverage = (values, size) =>
    values.map((_, i) => {
        const window = values.slice(Math.max(0, i - size + 1), i + 1);
        return sum(window) / window.length;
    });
const chartObservers = new Set();

function disposeCharts() {
    for (const observer of chartObservers) observer.disconnect();
    chartObservers.clear();
}

function periodFraction(period, d) {
    const dayFraction = (d.getHours() * 60 + d.getMinutes()) / 1440;
    if (period === "day") return dayFraction;
    if (period === "week") return (((d.getDay() + 6) % 7) + dayFraction) / 7;
    return (d.getDate() - 1 + dayFraction) / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function bucketKey(period, d) {
    if (period === "month") return `${d.getFullYear()}-${d.getMonth()}`;
    const back = period === "week" ? (d.getDay() + 6) % 7 : 0;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).toDateString();
}

/** Extra on top of the current bar if usage keeps its pace; only while the snapshot is from the current period. */
function projectionExtra(values, period, fetchedAt) {
    const fetched = new Date(fetchedAt);
    const actual = values.at(-1) ?? 0;
    if (Number.isNaN(fetched.getTime()) || bucketKey(period, fetched) !== bucketKey(period, new Date())) return null;
    const fraction = periodFraction(period, fetched);
    if (actual <= 0 || fraction < 0.01 || fraction >= 0.995) return null;
    return actual / fraction - actual;
}

const splitSeries = (period, metric, split) => (split === "total" ? null : (period.splits?.[metric]?.[split] ?? null));

/** The stored choices, falling back to what this snapshot can actually show. */
function chartSelection(charts) {
    const periodKey = charts[ui.chartPeriod] ? ui.chartPeriod : "day";
    const period = charts[periodKey];
    const metric = ui.chartMetric === "cost" && !period.cost ? "tokens" : ui.chartMetric;
    const split = splitSeries(period, metric, ui.chartSplit) ? ui.chartSplit : "total";
    return { periodKey, period, metric, split, rolling: ui.chartRolling && split === "total", meta: PERIOD_META[periodKey] };
}

function chartTitle({ meta, metric, split, rolling }) {
    const name = { tokens: "Token Usage", cost: "Est. Cost", sessions: "Sessions" }[metric];
    const by = split === "total" ? "" : ` by ${cap(split)}`;
    return `${name}${by} – ${meta.window}${rolling ? ` (${meta.rolling}-${meta.unit} rolling avg)` : ""}`;
}

/** Datasets, axes and formats per metric/split, following the extension's Chart.js configs. */
function chartSpec({ period, periodKey, metric, split, rolling, meta }, fetchedAt) {
    const totals = { tokens: period.tokens, cost: period.cost ?? [], sessions: period.sessions }[metric];
    const stacked = splitSeries(period, metric, split);
    const [baseLabel, baseRgb, baseFill] = { tokens: ["Tokens", SERIES_RGB.tokens, 0.6], cost: ["Est. Cost (UBB)", SERIES_RGB.cost, 0.6], sessions: ["Sessions", SERIES_RGB.sessionBars, 0.7] }[metric];
    const spec = {
        labels: period.labels,
        periodKey,
        window: meta.window,
        unit: meta.unit,
        bars: [],
        lines: [],
        y: {
            title: { tokens: "Tokens", cost: stacked ? "Estimated Cost (USD)" : "Estimated Cost (UBB)", sessions: "Sessions" }[metric],
            tick: { tokens: compact, cost: moneyTick, sessions: int }[metric],
            fmt: { tokens: int, cost: money, sessions: int }[metric],
            integer: metric === "sessions",
        },
        y1: null,
        stacked: Boolean(stacked),
        legend: true,
    };
    if (stacked) {
        stacked.forEach((s, i) => spec.bars.push({ label: s.label, data: s.data, rgb: s.other ? OTHER_RGB : PALETTE[i % PALETTE.length], fill: 0.6, series: true }));
    } else if (rolling) {
        const label = `${meta.rolling}-${meta.unit} rolling avg${metric === "cost" ? " (UBB)" : ""}`;
        spec.lines.push({ label, data: rollingAverage(totals, meta.rolling), rgb: baseRgb, axis: "y", smooth: true, point: 0.15 });
    } else {
        spec.bars.push({ label: baseLabel, data: totals, rgb: baseRgb, fill: baseFill, radius: metric === "sessions" ? 4 : 0 });
    }
    const extra = !rolling && (!stacked || metric === "tokens") ? projectionExtra(totals, periodKey, fetchedAt) : null;
    if (extra) {
        const last = totals.length - 1;
        spec.bars.push({
            label: meta.projected,
            data: totals.map((_, i) => (i === last ? extra : 0)),
            rgb: stacked ? SERIES_RGB.projection : baseRgb,
            fill: stacked || metric === "sessions" ? 0.25 : 0.2,
            stroke: 0.5,
            projection: true,
        });
    }
    if (metric === "tokens") {
        spec.lines.push({ label: "Sessions", data: period.sessions, rgb: SERIES_RGB.sessions, axis: "y1", point: 0.6 });
        spec.y1 = { title: "Sessions", tick: int, fmt: int };
    }
    if (metric === "sessions" && !stacked && !extra) spec.legend = false;
    return spec;
}

function niceScale(max, integer) {
    if (!(max > 0)) return { max: 1, step: 1 };
    const raw = max / 5;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    let step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw - 1e-9);
    if (integer) step = Math.max(1, Math.ceil(step));
    return { max: Math.ceil(max / step - 1e-9) * step, step };
}

/** Catmull-Rom style curve, like Chart.js `tension: 0.4`; control points stay inside the plot. */
function smoothPath(points, minY, maxY, tension = 0.4) {
    const clampY = (v) => Math.min(maxY, Math.max(minY, v));
    return points
        .map(([x, y], i) => {
            if (i === 0) return `M${fx(x)},${fx(y)}`;
            const [x0, y0] = points[i - 2] ?? points[i - 1];
            const [x1, y1] = points[i - 1];
            const [x3, y3] = points[i + 1] ?? [x, y];
            const c1 = [x1 + ((x - x0) * tension) / 2, clampY(y1 + ((y - y0) * tension) / 2)];
            const c2 = [x - ((x3 - x1) * tension) / 2, clampY(y - ((y3 - y1) * tension) / 2)];
            return `C${c1.map(fx)} ${c2.map(fx)} ${fx(x)},${fx(y)}`;
        })
        .join("");
}

function toggleSeries(label) {
    const hidden = new Set(ui.hiddenSeries);
    if (!hidden.delete(label)) hidden.add(label);
    update({ hiddenSeries: hidden });
}

/** Chart.js-style bar/line chart: legend on top (click to hide a series), index tooltip, optional right axis. */
function seriesChart(spec, title) {
    const { labels, periodKey } = spec;
    const n = labels.length;
    const shown = (s) => !ui.hiddenSeries.has(s.label);
    const bars = spec.bars.filter(shown);
    const lines = spec.lines.filter(shown);
    const axisLabel = periodKey === "day" ? shortDate : (label) => label;
    const tipTitle = periodKey === "day" ? longDate : (label) => label;
    const plot = h("div", { class: "series-plot" });
    const tip = h("div", { class: "series-tip", "aria-live": "polite", hidden: true });
    let geom = null;
    let hoverBand = null;
    let active = null;

    const swatch = (cls, s) => {
        const box = h("span", { class: cls, "aria-hidden": "true" });
        box.style.background = rgba(s.rgb, s.fill ?? s.point);
        box.style.borderColor = rgba(s.rgb, s.stroke ?? 1);
        return box;
    };
    const legend =
        spec.legend &&
        h(
            "div",
            { class: "series-legend" },
            [...spec.bars, ...spec.lines].map((s) =>
                h("button", { type: "button", class: "series-key", "aria-pressed": String(shown(s)), "data-key": `series:${s.label}`, title: `${shown(s) ? "Hide" : "Show"} ${s.label}`, onclick: () => toggleSeries(s.label) }, swatch("series-box", s), h("span", { class: "series-name" }, s.label)),
            ),
        );

    const text = (content, attrs) => {
        const el = svg("text", attrs);
        el.textContent = content;
        return el;
    };

    function select(i) {
        active = i;
        if (!geom) return;
        if (i == null) {
            tip.hidden = true;
            hoverBand.setAttribute("visibility", "hidden");
            return;
        }
        hoverBand.setAttribute("x", fx(geom.left + geom.band * i));
        hoverBand.setAttribute("visibility", "visible");
        const rows = [...bars, ...lines]
            .filter((s) => s.data[i] > 0 || !(s.series || s.projection))
            .map((s) => h("div", { class: "tip-row" }, swatch("tip-box", s), h("span", {}, `${s.label}: ${(s.axis === "y1" ? spec.y1.fmt : spec.y.fmt)(s.data[i])}`)));
        const stackTotal = sum(bars.filter((b) => !b.projection).map((b) => b.data[i]));
        tip.replaceChildren(
            h("div", { class: "tip-title" }, tipTitle(labels[i])),
            ...(rows.length ? rows : [h("div", { class: "tip-row" }, "No activity")]),
            ...(spec.stacked ? [h("div", { class: "tip-footer" }, `Total: ${spec.y.fmt(stackTotal)}`)] : []),
        );
        tip.hidden = false;
        const x = geom.xc(i);
        const left = x + 14 + tip.offsetWidth > geom.width - 2 ? x - 14 - tip.offsetWidth : x + 14;
        tip.style.left = `${Math.max(2, left)}px`;
        tip.style.top = `${geom.top + 4}px`;
    }

    function draw() {
        const width = plot.clientWidth;
        const height = plot.clientHeight;
        if (!width || !height) return;
        themeProbe.font = `11px ${getComputedStyle(plot).fontFamily}`;
        const textWidth = (value) => themeProbe.measureText(value).width;
        const ticks = (scale) => Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step);
        const stackTotals = labels.map((_, i) => sum(bars.map((b) => b.data[i])));
        const y = niceScale(Math.max(0, ...stackTotals, ...lines.filter((l) => l.axis === "y").flatMap((l) => l.data)), spec.y.integer);
        const y1 = spec.y1 && niceScale(Math.max(0, ...lines.filter((l) => l.axis === "y1").flatMap((l) => l.data)), true);
        const yTicks = ticks(y);
        const y1Ticks = y1 ? ticks(y1) : [];
        const left = 18 + Math.max(...yTicks.map((v) => textWidth(spec.y.tick(v)))) + 6;
        const right = y1 ? 18 + Math.max(...y1Ticks.map((v) => textWidth(spec.y1.tick(v)))) + 6 : 12;
        const top = 8;
        const plotW = Math.max(20, width - left - right);
        const plotH = Math.max(20, height - top - 22);
        const band = plotW / n;
        const xc = (i) => left + band * (i + 0.5);
        const yPx = (v) => top + plotH - (v / y.max) * plotH;
        const y1Px = (v) => top + plotH - (v / y1.max) * plotH;
        const crisp = (v) => Math.round(v) + 0.5;

        const root = svg("svg", { width, height, "aria-hidden": "true" });
        for (let i = 0; i <= n; i++) root.append(svg("line", { class: "grid", x1: crisp(left + band * i), x2: crisp(left + band * i), y1: top, y2: top + plotH }));
        for (const v of yTicks) {
            const yy = crisp(yPx(v));
            root.append(svg("line", { class: "grid", x1: left, x2: left + plotW, y1: yy, y2: yy }), text(spec.y.tick(v), { x: fx(left - 6), y: yy + 4, "text-anchor": "end" }));
        }
        for (const v of y1Ticks) root.append(text(spec.y1.tick(v), { x: fx(left + plotW + 6), y: crisp(y1Px(v)) + 4 }));
        root.append(text(spec.y.title, { class: "axis-title", transform: `translate(11 ${fx(top + plotH / 2)}) rotate(-90)`, "text-anchor": "middle" }));
        if (y1) root.append(text(spec.y1.title, { class: "axis-title", transform: `translate(${width - 11} ${fx(top + plotH / 2)}) rotate(90)`, "text-anchor": "middle" }));

        const labelWidth = Math.max(...labels.map((l) => textWidth(axisLabel(l)))) + 10;
        const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / labelWidth))));
        labels.forEach((label, i) => {
            if ((n - 1 - i) % every) return;
            const half = textWidth(axisLabel(label)) / 2;
            root.append(text(axisLabel(label), { x: fx(Math.min(Math.max(xc(i), half + 2), width - half - 2)), y: top + plotH + 16, "text-anchor": "middle" }));
        });

        hoverBand = svg("rect", { class: "hover-band", x: 0, y: top, width: fx(band), height: plotH, visibility: "hidden" });
        root.append(hoverBand);
        const barWidth = Math.max(1, band * 0.72);
        labels.forEach((_, i) => {
            let base = 0;
            for (const b of bars) {
                const v = b.data[i];
                if (!(v > 0)) continue;
                const y0 = yPx(base);
                const y1v = yPx(base + v);
                base += v;
                root.append(
                    svg("rect", {
                        x: fx(xc(i) - barWidth / 2),
                        y: fx(y1v),
                        width: fx(barWidth),
                        height: fx(Math.max(0.5, y0 - y1v)),
                        rx: b.radius ? Math.min(b.radius, barWidth / 2) : 0,
                        fill: rgba(b.rgb, b.fill),
                        stroke: rgba(b.rgb, b.stroke ?? 1),
                        "stroke-width": 1,
                    }),
                );
            }
        });
        for (const l of lines) {
            const scaleY = l.axis === "y1" ? y1Px : yPx;
            const points = l.data.map((v, i) => [xc(i), scaleY(v)]);
            const d = l.smooth ? smoothPath(points, top, top + plotH) : `M${points.map((p) => p.map(fx).join(",")).join("L")}`;
            root.append(svg("path", { class: "series-line", d, stroke: rgba(l.rgb, 1) }));
            for (const [x, yy] of points) root.append(svg("circle", { cx: fx(x), cy: fx(yy), r: 3, fill: rgba(l.rgb, l.point), stroke: rgba(l.rgb, 1), "stroke-width": 1 }));
        }
        geom = { left, band, top, width, xc };
        plot.replaceChildren(root, tip);
        if (active != null) select(active);
    }

    plot.addEventListener("pointermove", (event) => {
        if (!geom) return;
        const i = Math.floor((event.clientX - plot.getBoundingClientRect().left - geom.left) / geom.band);
        select(i >= 0 && i < n ? i : null);
    });
    plot.addEventListener("pointerleave", () => select(null));
    const wrapper = h(
        "div",
        { class: "series-chart", tabindex: "0", role: "group", "aria-label": `${title}. Use the arrow keys to read each ${spec.unit}.` },
        h("div", { class: "series-title" }, spec.window),
        legend,
        plot,
    );
    wrapper.addEventListener("keydown", (event) => {
        if (event.target !== wrapper) return;
        const next = { ArrowLeft: Math.max(0, (active ?? n) - 1), ArrowRight: Math.min(n - 1, (active ?? -1) + 1), Home: 0, End: n - 1, Escape: null }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        select(next);
    });
    wrapper.addEventListener("focusout", (event) => {
        if (!wrapper.contains(event.relatedTarget)) select(null);
    });
    const observer = new ResizeObserver(draw);
    observer.observe(plot);
    chartObservers.add(observer);
    return wrapper;
}

function chartSummary({ period, metric, meta }) {
    const n = period.labels.length;
    const tokens = sum(period.tokens);
    const sessions = sum(period.sessions);
    const cost = sum(period.cost ?? []);
    const unit = cap(meta.unit);
    const [totalLabel, total, avgLabel, avg] = {
        tokens: ["Total Tokens", compact(tokens), `Avg Tokens / ${unit}`, compact(tokens / n)],
        cost: ["Total Cost (est.)", usd(cost), `Avg Cost / ${unit}`, usd(cost / n)],
        sessions: ["Total Sessions", int(sessions), `Avg Sessions / ${unit}`, int(sessions / n)],
    }[metric];
    return h("div", { class: "cards" }, summaryCard(meta.count, int(n)), summaryCard(totalLabel, total), summaryCard(avgLabel, avg), summaryCard("Total Sessions", int(sessions)));
}

function editorCards(period) {
    const editors = period.splits?.tokens?.editor ?? [];
    if (!editors.length) return null;
    const collapsed = ui.editorCardsCollapsed;
    return h(
        "div",
        { class: "editor-section" },
        h(
            "button",
            {
                type: "button",
                class: "editor-list-toggle",
                "aria-expanded": String(!collapsed),
                "aria-controls": "editor-cards",
                "data-key": "editor-toggle",
                title: collapsed ? "Show per-editor breakdown" : "Hide per-editor breakdown",
                onclick: () => update({ editorCardsCollapsed: !collapsed }),
            },
            h("span", { class: "editor-list-chevron", "aria-hidden": "true" }, collapsed ? "▸" : "▾"),
            " By Editor",
        ),
        h("div", { class: "cards", id: "editor-cards", hidden: collapsed }, editors.map((e) => summaryCard(e.label, compact(sum(e.data))))),
    );
}

function chartControls(charts, { period, periodKey, metric, split, meta }) {
    const toggle = (key, label, active, onclick, extra = {}) => h("button", { type: "button", class: `toggle${active ? " active" : ""}`, "aria-pressed": String(active), "data-key": key, onclick, ...extra }, label);
    const pick = (patch) => update({ ...patch, hiddenSeries: new Set() });
    const group = (label, buttons) => h("div", { class: "control-group", role: "group", "aria-label": label.replace(/:$/, "") }, h("span", { class: "control-label" }, label), buttons);
    const hasSplit = (s) => s === "total" || Boolean(splitSeries(period, metric, s));
    // The CLI does not send repository datasets yet; only offer that split once some period has them.
    const hasRepositories = Object.values(charts).some((p) => p && Object.values(p.splits ?? {}).some((bySplit) => bySplit.repository));
    const splits = SPLITS.filter(([s]) => s !== "repository" || hasRepositories);
    return h(
        "div",
        { class: "chart-controls" },
        h(
            "div",
            { class: "chart-controls-row" },
            group(
                "Aggregate by",
                CHART_PERIODS.map(([p, label]) => toggle(`period:${p}`, label, p === periodKey, () => pick({ chartPeriod: p }), charts[p] ? { title: `Aggregate data by ${p}` } : { disabled: true, title: "Not available from this CLI version" })),
            ),
            split === "total" && [
                h("div", { class: "control-group-separator", "aria-hidden": "true" }),
                toggle("rolling", "📈 Rolling Avg", ui.chartRolling, () => pick({ chartRolling: !ui.chartRolling }), { title: `Show a ${meta.rolling}-${meta.unit} rolling average` }),
            ],
        ),
        h("div", { class: "chart-controls-row" }, group("Metric:", METRICS.map(([m, label]) => toggle(`metric:${m}`, label, m === metric, () => pick({ chartMetric: m }), { disabled: m === "cost" && !period.cost })))),
        h(
            "div",
            { class: "chart-controls-row" },
            group(
                "Split:",
                splits.map(([s, label]) =>
                    toggle(`split:${s}`, label, s === split, () => pick({ chartSplit: s }), hasSplit(s) ? { title: s === "total" ? null : "Click a name in the legend to hide its data" } : { disabled: true, title: `No per-${s} ${metric} data from the CLI` }),
                ),
            ),
        ),
    );
}

function renderChart(snapshot) {
    if (!snapshot.charts?.day) return [empty(snapshot.charts ? "No chart data in this snapshot." : "Chart data arrives with the next refresh.")];
    const selection = chartSelection(snapshot.charts);
    const spec = chartSpec(selection, snapshot.fetchedAt);
    // The CLI prices the Total at Copilot AI Credit rates but each editor/provider series at that tool's own rates,
    // so split cost bars need not add up to the Total. Say so rather than silently switching pricing bases.
    const costBasisNote =
        selection.metric === "cost" &&
        selection.split !== "total" &&
        h("p", { class: "panel-note" }, "Split cost bars price GitHub Copilot usage at AI Credit rates and other tools and providers at their API list prices, so they can differ from the Total, which prices everything at Copilot AI Credit (UBB) rates.");
    return [
        section("📊 Summary", chartSummary(selection), editorCards(selection.period)),
        section("📈 Charts", h("div", { class: "chart-shell" }, chartControls(snapshot.charts, selection), seriesChart(spec, chartTitle(selection))), costBasisNote),
        h("p", { class: "panel-note" }, `${selection.meta.footer} (${selection.meta.agg}) · Last updated: ${new Date(snapshot.fetchedAt).toLocaleString()}`),
    ];
}

// ---------- sessions ----------
const RANGE_DAYS = { today: 1, "7d": 7, "30d": 30 };

// Same rule as the CLI (src/timeWindows.ts): an N-day window starts at local midnight N-1 calendar days ago.
function inRange(session) {
    const t = Date.parse(session.lastActivity);
    if (!Number.isFinite(t)) return false;
    const now = new Date();
    const days = RANGE_DAYS[ui.range] ?? 30;
    return t >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime();
}

const sessionTitle = (s) => s.label || `${s.editor} session ${s.shortId}`;

function renderSessions(snapshot) {
    const sorters = {
        recent: (a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)),
        tokens: (a, b) => b.totalTokens - a.totalTokens,
        cost: (a, b) => b.estimatedCost - a.estimatedCost,
    };
    const summary = h("div", { class: "cards" });
    const results = h("div", {});
    const fill = () => {
        const q = ui.query.trim().toLowerCase();
        const list = snapshot.sessions
            .filter(inRange)
            .filter((s) => !q || [sessionTitle(s), s.project, s.editor, ...s.models].some((v) => v && v.toLowerCase().includes(q)))
            .sort(sorters[ui.sort]);
        summary.replaceChildren(
            summaryCard("Sessions", int(list.length)),
            summaryCard("Total Tokens", compact(sum(list.map((s) => s.totalTokens)))),
            summaryCard("Estimated cost", usd(sum(list.map((s) => s.estimatedCost))), "API list price"),
        );
        const more = list.length > ui.limit && h("button", { type: "button", class: "link", "data-key": "more-sessions", onclick: () => update({ limit: ui.limit + PAGE }) }, `Show ${Math.min(PAGE, list.length - ui.limit)} more`);
        results.replaceChildren(...[list.length ? h("ul", { class: "sessions" }, list.slice(0, ui.limit).map(sessionItem)) : empty(q ? "No sessions match that filter." : "No sessions in this range."), more].filter(Boolean));
    };

    // Typing only refreshes the results around the field: it stays mounted, so the caret, the selection and any input
    // method composition are left alone.
    const search = h("input", { class: "search", type: "search", "data-key": "search", placeholder: "Filter by name, project, tool or model", "aria-label": "Filter sessions", value: ui.query });
    search.addEventListener("input", () => {
        ui.query = search.value;
        ui.limit = PAGE;
        fill();
    });
    const sort = h("select", { "data-key": "sort", "aria-label": "Sort sessions", onchange: (e) => update({ sort: e.target.value, limit: PAGE }) }, SORTS.map(([v, t]) => h("option", { value: v, selected: v === ui.sort }, t)));
    fill();

    return [
        summary,
        section(
            null,
            h("div", { class: "toolbar" }, segmented("Time range", RANGES, ui.range, (v) => update({ range: v, limit: PAGE })), h("label", { class: "select-label" }, "Sort", sort)),
            search,
            results,
        ),
    ];
}

function sessionItem(s) {
    const active = minutes(s.activeDurationMs);
    return h(
        "li",
        { class: "session" },
        h("div", { class: "session-top" }, h("p", { class: `session-title${s.label ? "" : " fallback"}` }, sessionTitle(s)), h("span", { class: "session-when", title: new Date(s.lastActivity).toLocaleString() }, ago(s.lastActivity))),
        s.project && h("div", { class: "session-sub" }, s.project),
        h("div", { class: "chips" }, h("span", { class: "chip editor" }, `${editorIcon(s.editor)} ${s.editor}`), s.models.slice(0, 4).map((m) => h("span", { class: "chip" }, m)), s.models.length > 4 && h("span", { class: "chip" }, `+${s.models.length - 4}`)),
        h(
            "ul",
            { class: "metrics num" },
            h("li", { title: "Tokens" }, "🟣 ", h("strong", {}, compact(s.totalTokens)), " tokens"),
            h("li", { title: "Estimated cost at API list prices" }, "💵 ", h("strong", {}, usd(s.estimatedCost))),
            h("li", { title: "Interactions" }, "💬 ", h("strong", {}, int(s.interactions)), " turns"),
            h("li", { title: "Tool calls" }, "🔧 ", h("strong", {}, int(s.toolCalls)), " tool calls"),
            active && h("li", { title: "Active time" }, "⏱️ ", h("strong", {}, active)),
        ),
    );
}

// ---------- fluency ----------
const clampStage = (stage) => Math.min(4, Math.max(0, Math.round(Number(stage) || 0)));

/** Greedy word wrap for axis labels; spider labels need to stay narrow in a side panel. */
function wrapWords(text, max = 12) {
    const lines = [];
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
        const last = lines.length - 1;
        if (last >= 0 && lines[last].length + 1 + word.length <= max) lines[last] += ` ${word}`;
        else lines.push(word);
    }
    return lines.length > 2 ? [lines[0], lines.slice(1).join(" ")] : lines;
}

/** Same geometry as the extension's radar: stage rings 1–4, one axis per category, starting at the top. */
function radarChart(categories) {
    const n = categories.length;
    const W = 380, H = 290, cx = W / 2, cy = 146, maxR = 92, labelR = maxR + 13, lh = 13;
    const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const point = (i, r) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];
    const radius = (stage) => (clampStage(stage) / 4) * maxR;
    const polygon = (radii) => radii.map((r, i) => point(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");
    const describe = (c) => `${c.category}: stage ${c.stage}${STAGE_NAMES[c.stage] ? ` · ${STAGE_NAMES[c.stage]}` : ""}`;
    const ringNames = ["", "AI Skeptic", "Explorer", "Collaborator", "Strategist"];

    const chart = svg("svg", { class: "radar", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Fluency by category. ${categories.map(describe).join("; ")}.` });
    for (let level = 1; level <= 4; level++) chart.append(svg("polygon", { class: "radar-grid", points: polygon(Array(n).fill((level / 4) * maxR)) }));
    categories.forEach((_, i) => {
        const [x2, y2] = point(i, maxR);
        chart.append(svg("line", { class: "radar-grid", x1: cx, y1: cy, x2, y2 }));
    });
    chart.append(svg("polygon", { class: "radar-area", points: polygon(categories.map((c) => radius(c.stage))) }));
    for (let level = 1; level <= 4; level++) {
        const ring = svg("text", { class: "radar-ring", x: cx + 8, y: cy - (level / 4) * maxR + 10, "aria-hidden": "true" });
        ring.textContent = ringNames[level];
        chart.append(ring);
    }
    categories.forEach((c, i) => {
        const [x, y] = point(i, radius(c.stage));
        const dot = svg("circle", { class: "radar-dot", cx: x, cy: y, r: 4.5 });
        const tip = svg("title");
        tip.textContent = describe(c);
        dot.append(tip);
        chart.append(dot);

        const [lx, ly] = point(i, labelR);
        const cos = Math.cos(angle(i)), sin = Math.sin(angle(i));
        const lines = wrapWords(c.category);
        if (c.icon) lines[0] = `${c.icon} ${lines[0]}`;
        const offset = sin < -0.3 ? -(lines.length - 1) * lh - 4 : sin > 0.3 ? 5 : -((lines.length - 1) / 2) * lh;
        const label = svg("text", { class: "radar-label", "text-anchor": cos < -0.3 ? "end" : cos > 0.3 ? "start" : "middle", "aria-hidden": "true" });
        lines.forEach((line, j) => {
            const span = svg("tspan", { x: lx.toFixed(1), y: (ly + offset + j * lh).toFixed(1) });
            span.textContent = line;
            label.append(span);
        });
        chart.append(label);
    });
    return chart;
}

function stageLegend() {
    return h(
        "div",
        { class: "legend-panel" },
        h("div", { class: "legend-title" }, "Stage Reference"),
        [1, 2, 3, 4].map((s) =>
            h(
                "div",
                { class: `legend-item s${s}` },
                h("span", { class: "legend-dot", "aria-hidden": "true" }),
                h("div", {}, h("div", { class: "legend-label" }, `Stage ${s}: ${STAGE_NAMES[s]}`), h("div", { class: "legend-desc" }, STAGE_DESCRIPTIONS[s])),
            ),
        ),
    );
}

function categoryCard(c) {
    const stage = clampStage(c.stage);
    const fill = h("div", { class: "category-progress-fill" });
    fill.style.width = `${(stage / 4) * 100}%`;
    const evidence = c.evidence.length ? c.evidence : ["No significant activity detected"];
    return h(
        "li",
        { class: `category-card s${stage}` },
        h("div", { class: "category-header" }, h("span", { class: "category-name" }, `${c.icon} ${c.category}`), h("span", { class: "category-stage-badge" }, `Stage ${c.stage}`)),
        h("div", { class: "category-stage-label" }, `Stage ${c.stage}: ${STAGE_NAMES[c.stage] ?? "Unknown"}`),
        h("div", { class: "category-progress", role: "progressbar", "aria-label": `${c.category} stage`, "aria-valuemin": "0", "aria-valuemax": "4", "aria-valuenow": String(stage) }, fill),
        h(
            "ul",
            { class: "evidence-list" },
            evidence.map((e) => h("li", { class: "evidence-item" }, h("span", { class: "evidence-icon", "aria-hidden": "true" }, c.evidence.length ? "✓" : "-"), h("span", {}, e))),
        ),
        c.tips.length > 0 && h("div", { class: "tips-block" }, h("div", { class: "tips-title" }, "💡 Next steps to level up:"), c.tips.map((t) => h("div", { class: "tip-item" }, linkify(t)))),
    );
}

function renderFluency(snapshot) {
    const f = snapshot.fluency;
    if (!f) return [empty("No fluency score in this snapshot.")];
    const stage = clampStage(f.overallStage);
    return [
        h(
            "div",
            { class: "info-box" },
            h("div", { class: "info-box-title" }, "📋 About This Dashboard"),
            h("p", {}, "Maps your AI tool usage from the last 30 days to a maturity model with 4 stages across 6 categories, and suggests areas to explore next."),
            h("p", {}, "📖 ", h("a", { href: FLUENCY_DOCS, target: "_blank", rel: "noopener noreferrer" }, "Read the full scoring rules"), " to learn how each category and stage is calculated."),
        ),
        h(
            "div",
            { class: `stage-banner s${stage}` },
            h("div", { class: "stage-banner-label" }, "Overall AI Engineering Fluency"),
            h("div", { class: "stage-banner-title" }, f.overallLabel || `Stage ${f.overallStage}`),
            h("div", { class: "stage-banner-subtitle" }, STAGE_DESCRIPTIONS[stage] ?? ""),
        ),
        h("div", { class: "radar-wrapper" }, f.categories.length >= 3 && h("div", { class: "radar-container" }, radarChart(f.categories)), stageLegend()),
        h("ul", { class: "category-grid" }, f.categories.map(categoryCard)),
        h("p", { class: "panel-note" }, `Based on last 30 days of activity · Last updated: ${new Date(snapshot.fetchedAt).toLocaleString()}`),
    ];
}

// ---------- shell ----------
function renderTabs() {
    for (const tab of document.querySelectorAll("[role=tab]")) {
        const selected = tab.dataset.tab === ui.tab;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
    }
    document.getElementById("panel").setAttribute("aria-labelledby", `tab-${ui.tab}`);
    const [icon, title] = VIEWS[ui.tab];
    const charts = data.snapshot?.charts;
    document.getElementById("header-icon").textContent = icon;
    document.getElementById("header-title").textContent = ui.tab === "chart" && charts?.day ? chartTitle(chartSelection(charts)) : title;
}

// A rerender replaces the panel's fields; doing that mid-composition would break input-method typing, so it waits.
let composing = false;
let panelStale = false;
document.addEventListener("compositionstart", () => {
    composing = true;
});
document.addEventListener("compositionend", () => {
    composing = false;
    // After the composition's final input event, so the rebuilt field gets the committed text.
    setTimeout(() => {
        if (panelStale && !composing) renderPanel();
    });
});

function renderPanel() {
    const panel = document.getElementById("panel");
    const active = panel.contains(document.activeElement) ? document.activeElement : null;
    if (composing && active) {
        panelStale = true;
        return;
    }
    panelStale = false;
    const focusKey = active?.dataset?.key ?? null;
    const selection = active instanceof HTMLInputElement && active.selectionStart != null ? { value: active.value, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
    const { snapshot, status } = data;
    disposeCharts();
    let content;
    if (!snapshot) {
        content = [empty(status?.state === "running" ? "Collecting your stats… this first run can take several minutes." : status?.state === "error" ? "No data yet — the last refresh failed. Try Refresh." : "No data yet.")];
    } else {
        content = { overview: renderOverview, chart: renderChart, sessions: renderSessions, fluency: renderFluency }[ui.tab](snapshot);
    }
    panel.replaceChildren(...content.filter(Boolean));
    if (focusKey) {
        const target = panel.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
        target?.focus();
        if (target instanceof HTMLInputElement && target.selectionStart != null) {
            // Same text: put the caret/selection back where it was; otherwise at the end of the new text.
            if (selection?.value === target.value) target.setSelectionRange(selection.start, selection.end, selection.direction);
            else target.setSelectionRange(target.value.length, target.value.length);
        }
    }
}

function render() {
    renderHeader();
    renderTabs();
    renderPanel();
}

function update(patch) {
    Object.assign(ui, patch);
    for (const key of PERSISTED) {
        if (key in patch) localStorage.setItem(`ai-fluency.${key}`, String(ui[key]));
    }
    render();
}

document.querySelector("[role=tablist]").addEventListener("click", (event) => {
    const tab = event.target.closest("[role=tab]");
    if (tab) update({ tab: tab.dataset.tab, limit: PAGE });
});
document.querySelector("[role=tablist]").addEventListener("keydown", (event) => {
    const tabs = [...document.querySelectorAll("[role=tab]")];
    const i = tabs.findIndex((t) => t.dataset.tab === ui.tab);
    const next = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    update({ tab: tabs[next].dataset.tab, limit: PAGE });
    tabs[next].focus();
});
document.getElementById("refresh").addEventListener("click", async () => {
    const button = document.getElementById("refresh");
    button.disabled = true;
    try {
        // Relative URLs: every route lives under the panel's private path prefix (see server.mjs).
        const res = await fetch("api/refresh", { method: "POST" });
        if (res.ok) data = { ...data, status: await res.json() };
    } finally {
        renderHeader();
    }
});

function applyState(next) {
    const changedSnapshot = next.snapshot?.fetchedAt !== data.snapshot?.fetchedAt;
    data = next;
    if (changedSnapshot || !next.snapshot) render();
    else renderHeader();
}

const events = new EventSource("events");
events.addEventListener("state", (event) => applyState(JSON.parse(event.data)));
events.addEventListener("error", () => {
    if (!data.status) document.getElementById("subtitle").textContent = "Reconnecting…";
});
setInterval(tickHeader, 1000);
render();
