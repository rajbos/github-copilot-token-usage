import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildCostSpeedSectionHtml,
    buildMcpHealthSectionHtml,
    buildToolExecutionSectionsHtml,
    buildToolLatencySectionHtml,
    buildToolReliabilitySectionHtml,
    formatLatencyMs,
    type ToolExecutionSectionsInput,
} from '../../src/webview/usage/toolExecutionHtml';
import type { LatencyHistogram } from '../../src/webview/shared/types';

/** Mirrors formatUtils.escapeHtml for the one assertion that needs the escaped form of an id. */
function escapeHtmlForTest(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Header labels of the accompanying data table, in column order. */
function tableHeaders(html: string): string[] {
    return [...html.matchAll(/<span class="data-table-sort-label">([^<]*)<\/span>/g)].map(m => m[1]);
}

/** Text of every body cell of each table row, in column order. */
function rowCells(html: string): string[][] {
    const body = html.match(/<tbody>(.*?)<\/tbody>/s)?.[1] ?? '';
    return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(row => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(m => m[1]));
}

/** Histogram with `n` samples all in bucket `i` (durations in [2^i, 2^(i+1)) ms). */
function hist(i: number, n: number, sumMs = n * 2 ** i): LatencyHistogram {
    const buckets = new Array<number>(23).fill(0);
    buckets[i] = n;
    return { count: n, sumMs, buckets };
}

function sampleInput(overrides: Partial<ToolExecutionSectionsInput> = {}): ToolExecutionSectionsInput {
    return {
        toolCalls: {
            total: 170,
            // byTool deliberately over-counts (orphaned starts, re-logs): charts must not use it.
            byTool: { view: 130, powershell: 60, task: 9, report_intent: 3, __slash__commit: 2 },
            completedByTool: { view: 100, powershell: 40, task: 5, report_intent: 3 },
            failuresByTool: { powershell: 10 },
            latencyByTool: { view: hist(5, 100), powershell: hist(11, 40), task: hist(14, 5) },
            outputTokensByTool: { view: 100_000, powershell: 8_000, task: 5_000 },
        },
        mcpTools: {
            total: 20,
            byServer: { github: 20 },
            byTool: { get_file_contents: 20 },
            completedByServer: { github: 12 },
            failuresByServer: { github: 3 },
            latencyByServer: { github: hist(10, 12) },
        },
        resolveToolName: id => id === 'view' ? 'View File' : id,
        ...overrides,
    };
}

test('formatLatencyMs: ms / s / m ranges', () => {
    assert.equal(formatLatencyMs(0), '0ms');
    assert.equal(formatLatencyMs(41.4), '41ms');
    assert.equal(formatLatencyMs(1500), '1.5s');
    assert.equal(formatLatencyMs(12_400), '12s');
    assert.equal(formatLatencyMs(90_000), '1.5m');
    assert.equal(formatLatencyMs(7_200_000), '2.0h');
});

test('latency axis: values past one hour get their own tick instead of clamping to the 1h edge', () => {
    // bucket 22 is the overflow bucket (>= 2^22 ms ≈ 70 min)
    const input = sampleInput({ toolCalls: { total: 1, byTool: { slow: 1 }, completedByTool: { slow: 1 }, latencyByTool: { slow: hist(22, 4) } } });
    const html = buildToolLatencySectionHtml(input);
    assert.match(html, />2\.0h</, 'a 2h tick is rendered');
    const bar = html.match(/tool-exec-marker-p95" x1="([\d.]+)"/);
    const oneHour = html.match(/<text x="([\d.]+)" y="\d+" text-anchor="middle">1\.0h<\/text>/);
    assert.ok(bar && oneHour && Number(bar[1]) > Number(oneHour[1]), 'p95 marker sits to the right of the 1h tick');
});

test('reliability section: bars and table come from completed calls, not byTool starts', () => {
    const html = buildToolReliabilitySectionHtml(sampleInput());
    assert.match(html, /id="section-tool-reliability"/);
    assert.match(html, /Tool execution reliability/);
    assert.match(html, /View File/);
    assert.match(html, /tool-exec-bar-failure/);
    assert.match(html, />40 · 25%</, 'powershell: 40 completed, 10 failures — not the 60 starts in byTool');
    assert.match(html, />100</, 'view has no failures so no share suffix');
    assert.match(html, /<title>powershell: 30 succeeded, 10 failed<\/title>/, 'tooltip is a localized template');
    assert.doesNotMatch(html, /__slash__/, 'slash markers are not tool calls');
    // Accessible data table with the same numbers.
    assert.match(html, /<details class="tool-exec-table"><summary>Show as table<\/summary>/);
    assert.deepEqual(tableHeaders(html), ['Tool', 'Completed calls', 'Failed', 'Failure rate']);
    assert.deepEqual(rowCells(html).map(cells => cells[0]), ['View File', 'powershell', 'task', 'report_intent'], 'rows keep the chart order: most completed calls first');
    assert.deepEqual(rowCells(html)[1], ['powershell', '40', '10', '25%']);
    assert.match(html, /<td class="data-table-align-right tool-exec-num">40<\/td>/, 'numeric cells are right-aligned');
    assert.match(html, /id="data-table-root-tool-exec-reliability"/, 'the table has a stable per-section id');
});

test('reliability section: all-success periods render bars; only missing completion data is the empty state', () => {
    const allOk = sampleInput();
    delete allOk.toolCalls.failuresByTool;
    const html = buildToolReliabilitySectionHtml(allOk);
    assert.match(html, /<svg/);
    assert.match(html, />100</);
    assert.doesNotMatch(html, /tool-exec-empty/);

    const noOutcomes = sampleInput();
    delete noOutcomes.toolCalls.completedByTool;
    const empty = buildToolReliabilitySectionHtml(noOutcomes);
    assert.match(empty, /tool-exec-empty/);
    assert.match(empty, /No tool outcome data yet/);
    assert.doesNotMatch(empty, /<svg/);
});

test('latency section: p50 bar, p95 marker, log axis ticks, localized tooltip and table', () => {
    const html = buildToolLatencySectionHtml(sampleInput());
    assert.match(html, /id="section-tool-latency"/);
    assert.match(html, /tool-exec-marker-p95/);
    assert.match(html, />1ms</);
    assert.match(html, />1\.0s</);
    // powershell: all samples in [2048, 4096) → p50 and p95 land in that bucket
    assert.match(html, /<title>powershell: p50 [23]\.\ds, p95 [34]\.\ds, 40 calls<\/title>/);
    assert.match(html, /<title>View File: p50 \d+ms/);
    assert.deepEqual(tableHeaders(html), ['Tool', 'Completed calls', 'p50', 'p95']);
});

test('latency section: empty state and hidden automatic tools', () => {
    assert.match(buildToolLatencySectionHtml(sampleInput({ toolCalls: { total: 0, byTool: {} } })), /No tool latency data yet/);
    const html = buildToolLatencySectionHtml(sampleInput({ hiddenTools: new Set(['view']) }));
    assert.doesNotMatch(html, /View File/);
    assert.match(html, /powershell/);
});

test('MCP health section: failure share over completed calls, not byServer starts', () => {
    const html = buildMcpHealthSectionHtml(sampleInput());
    assert.match(html, /id="section-mcp-health"/);
    assert.match(html, /12 · 25% fail/, '3 of 12 completed — not 3 of the 20 starts in byServer');
    assert.deepEqual(tableHeaders(html), ['Server', 'Completed calls', 'Failed', 'Failure rate']);
    const input = sampleInput();
    delete input.mcpTools.completedByServer;
    assert.match(buildMcpHealthSectionHtml(input), /No MCP server calls with a recorded outcome/);
});

test('cost vs speed section: tokens per completed call, coloured by kind, with table', () => {
    const html = buildCostSpeedSectionHtml(sampleInput());
    assert.match(html, /id="section-tool-cost-speed"/);
    assert.match(html, /tool-exec-kind-builtin/);
    assert.match(html, /tool-exec-kind-subagent/, 'task is a delegation tool');
    assert.match(html, /<title>View File \(builtin\): p50 \d+ms, 1,000 tokens per call, 100 calls<\/title>/, '100,000 tokens over 100 completed calls, not 130 starts');
    assert.match(html, /top-right = heavy &amp; slow/);
    assert.deepEqual(tableHeaders(html), ['Tool', 'Kind', 'Completed calls', 'p50', 'Tokens / call']);
    assert.match(buildCostSpeedSectionHtml(sampleInput({ toolCalls: { total: 1, byTool: { view: 1 }, completedByTool: { view: 1 } } })), /No tools have both latency/);
});

test('all sections: tool ids are HTML-escaped and the four sections render in order', () => {
    const input = sampleInput({
        toolCalls: {
            total: 1,
            byTool: { '<script>x</script>': 1 },
            completedByTool: { '<script>x</script>': 1 },
            failuresByTool: { '<script>x</script>': 1 },
            latencyByTool: { '<script>x</script>': hist(3, 1) },
            outputTokensByTool: { '<script>x</script>': 50 },
        },
    });
    const html = buildToolExecutionSectionsHtml(input);
    // Plain substring checks on purpose: this asserts that escapeHtml ran on the id, it is not an HTML filter.
    const rawId = '<script>x</script>';
    assert.equal(html.includes(rawId), false, 'raw tool id must not reach the markup');
    assert.equal(html.includes(escapeHtmlForTest(rawId)), true, 'tool id must be rendered escaped');
    const order = ['section-tool-reliability', 'section-tool-latency', 'section-mcp-health', 'section-tool-cost-speed'].map(id => html.indexOf(`id="${id}"`));
    assert.ok(order.every((pos, i) => pos >= 0 && (i === 0 || pos > order[i - 1])), `sections out of order: ${order.join(',')}`);
});
