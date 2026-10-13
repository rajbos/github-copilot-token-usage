import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildMcpPeriodTablesHtml,
    buildToolPeriodTableHtml,
    isMcpPeriodView,
    selectToolPeriodRows,
    type ToolPeriodCounts,
    type ToolPeriodTableOptions,
} from '../../src/webview/usage/toolPeriodTable';
import { formatNumber } from '../../src/webview/shared/formatUtils';

const identity = (id: string): string => id;

function options(overrides: Partial<ToolPeriodTableOptions> = {}): ToolPeriodTableOptions {
    return {
        tableId: 'tp-default',
        ariaLabelKey: 'usage.toolPeriod.ariaToolUsage',
        limitPerPeriod: 10,
        nameResolver: identity,
        firstColumnKey: 'usage.toolPeriod.colTool',
        totalLabelKey: 'usage.toolPeriod.totalToolCalls',
        emptyKey: 'usage.toolPeriod.emptyTools',
        emptyHiddenKey: 'usage.toolPeriod.emptyToolsHidden',
        ...overrides,
    };
}

const totals = { today: 7, last30Days: 9999, lastMonth: 42 };

/** The table body markup (rows only, no header or totals footer). */
function tbody(html: string): string {
    return html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
}

/** Body rows in document order. */
function bodyRows(html: string): string[] {
    return [...tbody(html).matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(m => m[0]);
}

test('selectToolPeriodRows: rows are the union of each period top N, with counts for every period', () => {
    const counts: ToolPeriodCounts = {
        today: { a: 5, b: 4, onlyToday: 3 },
        last30Days: { a: 50, b: 40, c: 30, onlyToday: 1 },
        lastMonth: { c: 9, d: 8 },
    };
    const rows = selectToolPeriodRows(counts, 2, identity);
    assert.deepEqual(rows.map(r => r.id).sort(), ['a', 'b', 'c', 'd']);
    // 'onlyToday' is third in today and fourth in last30Days: not in any top 2.
    assert.ok(!rows.some(r => r.id === 'onlyToday'));
    const d = rows.find(r => r.id === 'd')!;
    assert.deepEqual(d.counts, { today: 0, last30Days: 0, lastMonth: 8 });
    const a = rows.find(r => r.id === 'a')!;
    assert.deepEqual(a.counts, { today: 5, last30Days: 50, lastMonth: 0 });
});

test('selectToolPeriodRows: a period can add rows beyond N (union can exceed the limit)', () => {
    const counts: ToolPeriodCounts = {
        today: { x: 1 },
        last30Days: { y: 1 },
        lastMonth: { z: 1 },
    };
    assert.equal(selectToolPeriodRows(counts, 1, identity).length, 3);
});

test('selectToolPeriodRows: default sort is Last 30 Days desc, then Today desc, then name', () => {
    const counts: ToolPeriodCounts = {
        today: { b: 2, c: 1, a: 1 },
        last30Days: { low: 1, b: 10, c: 10, a: 10 },
        lastMonth: {},
    };
    const rows = selectToolPeriodRows(counts, 10, identity);
    assert.deepEqual(rows.map(r => r.id), ['b', 'a', 'c', 'low']);
});

test('selectToolPeriodRows: hidden ids are excluded case-insensitively and do not consume top-N slots', () => {
    const counts: ToolPeriodCounts = {
        today: {},
        last30Days: { Auto_Tool: 100, real: 5, other: 4 },
        lastMonth: {},
    };
    const rows = selectToolPeriodRows(counts, 2, identity, new Set(['auto_tool']));
    assert.deepEqual(rows.map(r => r.id), ['real', 'other']);
});

test('selectToolPeriodRows: zero and non-numeric counts never create rows', () => {
    const counts = {
        today: { zero: 0, bad: Number.NaN },
        last30Days: {},
        lastMonth: {},
    } as ToolPeriodCounts;
    assert.deepEqual(selectToolPeriodRows(counts, 10, identity), []);
});

test('buildToolPeriodTableHtml: renders through the shared data table, sorted by Last 30 Days', () => {
    const html = buildToolPeriodTableHtml(
        { today: { a: 1 }, last30Days: { a: 2 }, lastMonth: { a: 3 } },
        totals,
        options({ tableId: 'tp-shared' }),
    );
    assert.ok(html.includes('id="data-table-root-tp-shared"'), 'uses renderDataTable');
    assert.ok(html.includes('<table class="data-table data-table--fixed" aria-label="Tool usage by period">'));
    for (const header of ['Today', 'Last 30 Days', 'Previous Month']) {
        assert.ok(html.includes(header), header);
    }
    assert.match(html, /<th[^>]*aria-sort="descending"[^>]*>[\s\S]*?Last 30 Days/, 'Last 30 Days is the initial sort');
});

test('buildToolPeriodTableHtml: the totals row is a footer and uses the period total, not the sum of rows', () => {
    const html = buildToolPeriodTableHtml(
        { today: { a: 1 }, last30Days: { a: 2 }, lastMonth: { a: 3 } },
        totals,
        options({ tableId: 'tp-total' }),
    );
    const footer = html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'));
    assert.ok(footer.includes('Total tool calls'));
    assert.ok(footer.includes(formatNumber(9999)));
    assert.ok(footer.includes('>7<') && footer.includes('>42<'));
    assert.ok(!tbody(html).includes('Total tool calls'), 'the total is not a sortable body row');
});

test('buildToolPeriodTableHtml: zero counts render as a muted dash', () => {
    const html = buildToolPeriodTableHtml({ today: {}, last30Days: { a: 2 }, lastMonth: {} }, totals, options({ tableId: 'tp-zero' }));
    const [row] = bodyRows(html);
    assert.equal((row.match(/<span class="data-table-muted">–<\/span>/g) ?? []).length, 2);
});

test('buildToolPeriodTableHtml: auto filter removes automatic tools; auto badge still marks unfiltered ones', () => {
    const counts: ToolPeriodCounts = { today: {}, last30Days: { auto_tool: 9, real: 3 }, lastMonth: {} };
    const auto = new Set(['auto_tool']);
    const filtered = buildToolPeriodTableHtml(counts, totals, options({ tableId: 'tp-auto-1', hiddenIds: auto, autoIds: auto }));
    assert.ok(!filtered.includes('auto_tool'));
    assert.ok(filtered.includes('real'));

    const unfiltered = buildToolPeriodTableHtml(counts, totals, options({ tableId: 'tp-auto-2', autoIds: auto }));
    assert.ok(unfiltered.includes('<strong title="auto_tool">auto_tool</strong><span class="auto-badge"'));
});

test('buildToolPeriodTableHtml: empty states keep the totals footer', () => {
    const empty = buildToolPeriodTableHtml(
        { today: {}, last30Days: {}, lastMonth: {} },
        { today: 0, last30Days: 0, lastMonth: 0 },
        options({ tableId: 'tp-empty-1' }),
    );
    assert.ok(tbody(empty).includes('No tools used yet'));
    assert.ok(empty.includes('<tfoot>'), 'totals footer stays visible when empty');

    const allHidden = buildToolPeriodTableHtml(
        { today: {}, last30Days: { auto_tool: 4 }, lastMonth: {} },
        totals,
        options({ tableId: 'tp-empty-2', hiddenIds: new Set(['auto_tool']) }),
    );
    assert.ok(allHidden.includes('No purposeful tools used yet (automatic tool calls are hidden)'));
});

test('buildToolPeriodTableHtml: names and ids are HTML-escaped', () => {
    const html = buildToolPeriodTableHtml(
        { today: {}, last30Days: { '<img src=x>': 1 }, lastMonth: {} },
        totals,
        options({ tableId: 'tp-escape', nameResolver: () => '<b>"x"</b>' }),
    );
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<b>'));
    assert.ok(html.includes('&lt;img src=x&gt;'));
});

test('buildToolPeriodTableHtml: ids sharing a friendly name stay separate rows with the raw id shown', () => {
    const html = buildToolPeriodTableHtml(
        { today: {}, last30Days: { run_in_terminal: 5, powershell: 3, read_file: 2 }, lastMonth: {} },
        totals,
        options({ tableId: 'tp-dupes', nameResolver: id => (id === 'read_file' ? 'Read' : 'PowerShell') }),
    );
    const rows = bodyRows(html);
    assert.equal(rows.length, 3);
    assert.ok(rows[0].includes('<span class="tool-period-id data-table-muted">run_in_terminal</span>'));
    assert.ok(rows[1].includes('<span class="tool-period-id data-table-muted">powershell</span>'));
    assert.ok(!rows[2].includes('tool-period-id'), 'unique names get no hint');
});

test('buildMcpPeriodTablesHtml: By Server is default with server names resolved, By Tool is hidden and uses the MCP tool resolver', () => {
    const html = buildMcpPeriodTablesHtml({
        byServer: { today: { github: 2 }, last30Days: { github: 9, playwright: 4 }, lastMonth: {} },
        byTool: { today: {}, last30Days: { 'github/create_issue': 5 }, lastMonth: {} },
        totals: { today: 2, last30Days: 13, lastMonth: 0 },
        nameResolver: id => `Friendly ${id}`,
        serverNameResolver: id => (id === 'github' ? 'GitHub MCP' : id),
        view: 'server',
    });
    assert.ok(html.includes('data-mcp-view="server" aria-pressed="true"'));
    assert.ok(html.includes('data-mcp-view="tool" aria-pressed="false"'));
    assert.ok(html.includes('<div id="mcp-period-server" class="tool-period-view">'));
    assert.ok(html.includes('<div id="mcp-period-tool" class="tool-period-view" hidden>'));
    assert.ok(html.includes('id="data-table-root-mcp-period-servers"'));
    assert.ok(html.includes('id="data-table-root-mcp-period-tools"'));
    assert.ok(html.includes('Friendly github/create_issue'));
    assert.ok(html.includes('<strong title="github">GitHub MCP</strong>'), 'server ids go through the server resolver');
    assert.ok(html.includes('<strong title="playwright">playwright</strong>'));
    assert.ok(html.includes('aria-label="MCP calls by server and period"'));
    assert.ok(html.includes('aria-label="MCP calls by tool and period"'));
    assert.equal((html.match(/Total MCP calls/g) ?? []).length, 2);
});

test('buildMcpPeriodTablesHtml: By Tool view shows the tool table and the server table hidden', () => {
    const html = buildMcpPeriodTablesHtml({
        byServer: { today: {}, last30Days: {}, lastMonth: {} },
        byTool: { today: {}, last30Days: {}, lastMonth: {} },
        totals: { today: 0, last30Days: 0, lastMonth: 0 },
        nameResolver: identity,
        serverNameResolver: identity,
        view: 'tool',
    });
    assert.ok(html.includes('<div id="mcp-period-server" class="tool-period-view" hidden>'));
    assert.ok(html.includes('<div id="mcp-period-tool" class="tool-period-view">'));
    assert.equal((html.match(/No MCP tools used yet/g) ?? []).length, 2);
});

test('buildMcpPeriodTablesHtml: By Server keeps every server (paged), By Tool caps at top 10 per period', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 15; i++) { many[`s${i}`] = i + 1; }
    const html = buildMcpPeriodTablesHtml({
        byServer: { today: {}, last30Days: many, lastMonth: {} },
        byTool: { today: {}, last30Days: many, lastMonth: {} },
        totals: { today: 0, last30Days: 120, lastMonth: 0 },
        nameResolver: identity,
        serverNameResolver: identity,
        view: 'server',
    });
    const server = html.slice(html.indexOf('id="mcp-period-server"'), html.indexOf('id="mcp-period-tool"'));
    const tool = html.slice(html.indexOf('id="mcp-period-tool"'));
    assert.ok(server.includes('Page 1 of 2 · Showing 1–10 of 15'), 'all 15 servers are kept, paged by the shared table');
    assert.ok(tool.includes('Showing 1–10 of 10'));
});

test('isMcpPeriodView guards persisted state', () => {
    assert.equal(isMcpPeriodView('server'), true);
    assert.equal(isMcpPeriodView('tool'), true);
    assert.equal(isMcpPeriodView('x'), false);
    assert.equal(isMcpPeriodView(undefined), false);
});
