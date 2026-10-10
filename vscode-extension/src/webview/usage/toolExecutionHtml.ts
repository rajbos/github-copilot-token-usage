/**
 * Tool execution sections for Usage Analysis › Tools & Integrations: reliability
 * (success/failure volume per tool), latency (p50/p95 per tool), MCP server
 * health, and the cost-vs-speed map. Pure string builders over the additive
 * per-tool stats described in docs/adr/TOOL-EXECUTION-STATS.md.
 *
 * Hand-written SVG, like the efficiency-frontier chart in main.ts, so the usage
 * bundle stays chart-library-free. Every chart is followed by a collapsed data
 * table carrying the same numbers, so the values are reachable without hover
 * and by assistive technology (the SVG itself is a single `role="img"`).
 *
 * All denominators are the `completedBy*` maps — calls whose log recorded an
 * outcome — never `byTool` / `byServer`, which also count starts from editors
 * without completion events, orphaned starts and streaming re-logs. Every
 * section degrades to an explanatory empty state when its map is absent.
 */
import { renderDataTable, type DataTableColumn, type DataTableSortValue } from '../shared/dataTable';
import { escapeHtml, formatNumber, formatCompact } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import type { LatencyHistogram, McpToolUsage, ToolCallUsage } from '../shared/types';
import { latencyPercentileMs } from '../../../../src/latencyHistogram';
import { classifyToolKind, type ToolKind } from '../../../../src/toolKind';

export interface ToolExecutionSectionsInput {
	toolCalls: ToolCallUsage;
	mcpTools: McpToolUsage;
	/** Tool id → display name (the usage view's `lookupToolName`). */
	resolveToolName: (id: string) => string;
	/** Tool ids to leave out, e.g. automatic tool calls when the user hides them. */
	hiddenTools?: ReadonlySet<string>;
}

const TOP_N = 8;
const WIDTH = 900;
const LABEL_W = 200;
const PLOT_LEFT = LABEL_W + 12;
const ROW_H = 26;
const TOP_PAD = 14;
const BOTTOM_PAD = 30;

/** Format milliseconds the way a latency axis reads: 40ms · 1.5s · 12s · 2.0m · 1.5h. */
export function formatLatencyMs(ms: number): string {
	if (ms < 1000) { return `${Math.round(ms)}ms`; }
	if (ms < 60_000) { return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`; }
	if (ms < 3_600_000) { return `${(ms / 60_000).toFixed(1)}m`; }
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Failure share as the chart prints it: one decimal under 10 %, whole numbers above. */
function formatFailShare(failures: number, completed: number): string {
	const pct = completed > 0 ? (100 * failures) / completed : 0;
	return `${pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}%`;
}

/**
 * Axis tick candidates on a log latency scale (ms). The last tick must sit above
 * the histogram's largest possible estimate: its overflow bucket starts at 2^22 ms
 * (~70 min) and log-interpolation inside it can reach ~140 min, so the list runs
 * to 4 h rather than clamping everything past one hour onto the right edge.
 */
const LATENCY_TICKS = [1, 10, 100, 1000, 10_000, 60_000, 600_000, 3_600_000, 7_200_000, 14_400_000];

function logPos(value: number, min: number, max: number, left: number, right: number): number {
	const v = Math.max(min, Math.min(max, value));
	const span = Math.log10(max) - Math.log10(min);
	if (span <= 0) { return left; }
	return left + ((Math.log10(v) - Math.log10(min)) / span) * (right - left);
}

/** Smallest tick at or above `value`, so the axis ends on a labelled line. */
function ceilToTick(value: number, ticks: readonly number[]): number {
	return ticks.find(t => t >= value) ?? ticks[ticks.length - 1];
}

function sectionHtml(id: string, icon: string, titleKey: string, subtitleKey: string, body: string): string {
	return `<div class="section" id="${id}">
		<div class="section-title"><span>${icon}</span><span>${escapeHtml(localize(titleKey))}</span></div>
		<div class="section-subtitle">${escapeHtml(localize(subtitleKey))}</div>
		${body}
	</div>`;
}

function emptyHtml(key: string): string {
	return `<div class="tool-exec-empty">${escapeHtml(localize(key))}</div>`;
}

function isReportableTool(id: string, hidden: ReadonlySet<string> | undefined): boolean {
	// `__slash__…` / `__auto_compact__` markers live in byTool but are not tool calls.
	return !id.startsWith('__') && !(hidden?.has(id.toLowerCase()) ?? false);
}

function svgOpen(height: number, ariaLabel: string): string {
	return `<div class="tool-exec-chart-wrap"><svg class="tool-exec-chart" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">`;
}

function rowLabel(y: number, id: string, name: string): string {
	return `<text class="tool-exec-label" x="${LABEL_W}" y="${y + 4}" text-anchor="end"><title>${escapeHtml(id)}</title>${escapeHtml(name)}</text>`;
}

function legendSwatch(cssClass: string, label: string): string {
	return `<span><svg width="12" height="12" aria-hidden="true"><rect class="${cssClass}" width="12" height="12" rx="2"/></svg>${escapeHtml(label)}</span>`;
}

interface ToolExecColumn<Row> {
	/** Localization key of the header; its last segment is the column id. */
	key: string;
	numeric?: boolean;
	sortValue: (row: Row) => DataTableSortValue;
	/** Plain text; the table escapes it. */
	render: (row: Row) => string;
}

/** The collapsed data table that accompanies every chart, sorted by completed calls like the chart. */
function toolExecTableHtml<Row>(tableId: string, titleKey: string, columns: readonly ToolExecColumn<Row>[], rows: readonly Row[]): string {
	const table = renderDataTable<Row>({
		tableId: `tool-exec-${tableId}`,
		ariaLabel: localize(titleKey),
		rows,
		columns: columns.map((column): DataTableColumn<Row> => ({
			id: column.key.split('.').pop() ?? column.key,
			label: localize(column.key),
			align: column.numeric ? 'right' : undefined,
			className: column.numeric ? 'tool-exec-num' : undefined,
			sortValue: column.sortValue,
			render: row => column.render(row),
		})),
		initialSort: { columnId: 'completed', direction: 'desc' },
		className: 'data-table--compact',
	});
	return `<details class="tool-exec-table"><summary>${escapeHtml(localize('usage.toolExec.table.show'))}</summary>${table}</details>`;
}

const TOOL_COLUMN: ToolExecColumn<{ name: string }> = { key: 'usage.toolExec.col.tool', sortValue: r => r.name, render: r => r.name };
const COMPLETED_COLUMN: ToolExecColumn<{ completed: number }> = { key: 'usage.toolExec.col.completed', numeric: true, sortValue: r => r.completed, render: r => formatNumber(r.completed) };
const FAILED_COLUMN: ToolExecColumn<{ failures: number }> = { key: 'usage.toolExec.col.failed', numeric: true, sortValue: r => r.failures, render: r => formatNumber(r.failures) };
const FAIL_RATE_COLUMN: ToolExecColumn<{ completed: number; failures: number }> = {
	key: 'usage.toolExec.col.failRate', numeric: true,
	sortValue: r => r.completed > 0 ? r.failures / r.completed : 0,
	render: r => formatFailShare(r.failures, r.completed),
};

// ── Reliability ────────────────────────────────────────────────────────────────

interface ReliabilityRow { id: string; name: string; completed: number; failures: number; }

function reliabilityRows(input: ToolExecutionSectionsInput): ReliabilityRow[] {
	const failures = input.toolCalls.failuresByTool ?? {};
	return Object.entries(input.toolCalls.completedByTool ?? {})
		.filter(([id, completed]) => completed > 0 && isReportableTool(id, input.hiddenTools))
		.map(([id, completed]) => ({ id, name: input.resolveToolName(id), completed, failures: Math.min(completed, failures[id] ?? 0) }))
		.sort((a, b) => b.completed - a.completed)
		.slice(0, TOP_N);
}

function buildReliabilityChart(rows: ReliabilityRow[]): string {
	const plotRight = WIDTH - 90;
	const max = Math.max(1, ...rows.map(r => r.completed));
	const height = TOP_PAD + rows.length * ROW_H + BOTTOM_PAD;
	const x = (v: number) => PLOT_LEFT + (v / max) * (plotRight - PLOT_LEFT);
	const grid = [0.25, 0.5, 0.75, 1].map(f => {
		const gx = x(max * f);
		return `<line x1="${gx}" y1="${TOP_PAD}" x2="${gx}" y2="${height - BOTTOM_PAD + 4}"/><text x="${gx}" y="${height - 8}" text-anchor="middle">${formatCompact(Math.round(max * f))}</text>`;
	}).join('');
	const bars = rows.map((r, i) => {
		const y = TOP_PAD + i * ROW_H + ROW_H / 2;
		const okW = Math.max(0, x(r.completed - r.failures) - PLOT_LEFT);
		const failW = Math.max(0, x(r.completed) - x(r.completed - r.failures));
		const label = r.failures > 0 ? `${formatNumber(r.completed)} · ${formatFailShare(r.failures, r.completed)}` : formatNumber(r.completed);
		const tip = escapeHtml(localizeFormat('usage.toolExec.tip.reliability', r.name, formatNumber(r.completed - r.failures), formatNumber(r.failures)));
		return `${rowLabel(y, r.id, r.name)}
			<rect class="tool-exec-bar-success" x="${PLOT_LEFT}" y="${y - 8}" width="${okW}" height="16" rx="3"><title>${tip}</title></rect>
			<rect class="tool-exec-bar-failure" x="${PLOT_LEFT + okW}" y="${y - 8}" width="${failW}" height="16" rx="3"><title>${tip}</title></rect>
			<text x="${plotRight + 8}" y="${y + 4}">${label}</text>`;
	}).join('');
	return `${svgOpen(height, localize('usage.toolExec.reliability.title'))}<g class="tool-exec-grid">${grid}</g>${bars}</svg></div>`;
}

function reliabilityTable(rows: ReliabilityRow[]): string {
	return toolExecTableHtml<ReliabilityRow>('reliability', 'usage.toolExec.reliability.title', [TOOL_COLUMN, COMPLETED_COLUMN, FAILED_COLUMN, FAIL_RATE_COLUMN], rows);
}

export function buildToolReliabilitySectionHtml(input: ToolExecutionSectionsInput): string {
	const rows = reliabilityRows(input);
	const legend = `<div class="tool-exec-legend">${legendSwatch('tool-exec-bar-success', localize('usage.toolExec.legend.success'))}${legendSwatch('tool-exec-bar-failure', localize('usage.toolExec.legend.failure'))}</div>`;
	const body = rows.length > 0 ? legend + buildReliabilityChart(rows) + reliabilityTable(rows) : emptyHtml('usage.toolExec.empty.reliability');
	return sectionHtml('section-tool-reliability', '🛡️', 'usage.toolExec.reliability.title', 'usage.toolExec.reliability.subtitle', body);
}

// ── Latency ────────────────────────────────────────────────────────────────────

interface LatencyRow { id: string; name: string; count: number; p50: number; p95: number; }

function latencyRows(byTool: { [id: string]: LatencyHistogram } | undefined, input: ToolExecutionSectionsInput): LatencyRow[] {
	if (!byTool) { return []; }
	const rows: LatencyRow[] = [];
	for (const [id, h] of Object.entries(byTool)) {
		if (!isReportableTool(id, input.hiddenTools) || h.count <= 0) { continue; }
		const p50 = latencyPercentileMs(h, 0.5);
		const p95 = latencyPercentileMs(h, 0.95);
		if (p50 === null || p95 === null) { continue; }
		rows.push({ id, name: input.resolveToolName(id), count: h.count, p50, p95 });
	}
	return rows.sort((a, b) => b.count - a.count).slice(0, TOP_N);
}

function latencyAxis(min: number, max: number, plotRight: number, height: number): string {
	return LATENCY_TICKS.filter(t => t >= min && t <= max).map(t => {
		const gx = logPos(t, min, max, PLOT_LEFT, plotRight);
		return `<line x1="${gx}" y1="${TOP_PAD}" x2="${gx}" y2="${height - BOTTOM_PAD + 4}"/><text x="${gx}" y="${height - 8}" text-anchor="middle">${formatLatencyMs(t)}</text>`;
	}).join('');
}

function buildLatencyChart(rows: LatencyRow[]): string {
	const plotRight = WIDTH - 110;
	const min = 1;
	const max = ceilToTick(Math.max(10, ...rows.map(r => r.p95)), LATENCY_TICKS);
	const height = TOP_PAD + rows.length * ROW_H + BOTTOM_PAD;
	const bars = rows.map((r, i) => {
		const y = TOP_PAD + i * ROW_H + ROW_H / 2;
		const x50 = logPos(r.p50, min, max, PLOT_LEFT, plotRight);
		const x95 = logPos(r.p95, min, max, PLOT_LEFT, plotRight);
		const tip = escapeHtml(localizeFormat('usage.toolExec.tip.latency', r.name, formatLatencyMs(r.p50), formatLatencyMs(r.p95), formatNumber(r.count)));
		return `${rowLabel(y, r.id, r.name)}
			<rect class="tool-exec-bar-p95" x="${x50}" y="${y - 6}" width="${Math.max(0, x95 - x50)}" height="12" rx="2"/>
			<rect class="tool-exec-bar-p50" x="${PLOT_LEFT}" y="${y - 8}" width="${Math.max(1, x50 - PLOT_LEFT)}" height="16" rx="3"><title>${tip}</title></rect>
			<line class="tool-exec-marker-p95" x1="${x95}" y1="${y - 9}" x2="${x95}" y2="${y + 9}"/>
			<text x="${plotRight + 8}" y="${y + 4}">${formatLatencyMs(r.p50)} · ${formatLatencyMs(r.p95)}</text>`;
	}).join('');
	return `${svgOpen(height, localize('usage.toolExec.latency.title'))}<g class="tool-exec-grid">${latencyAxis(min, max, plotRight, height)}</g>${bars}</svg></div>`;
}

function latencyTable(rows: LatencyRow[]): string {
	return toolExecTableHtml<LatencyRow>('latency', 'usage.toolExec.latency.title', [
		TOOL_COLUMN,
		{ key: 'usage.toolExec.col.completed', numeric: true, sortValue: r => r.count, render: r => formatNumber(r.count) },
		{ key: 'usage.toolExec.col.p50', numeric: true, sortValue: r => r.p50, render: r => formatLatencyMs(r.p50) },
		{ key: 'usage.toolExec.col.p95', numeric: true, sortValue: r => r.p95, render: r => formatLatencyMs(r.p95) },
	], rows);
}

export function buildToolLatencySectionHtml(input: ToolExecutionSectionsInput): string {
	const rows = latencyRows(input.toolCalls.latencyByTool, input);
	const legend = `<div class="tool-exec-legend">${legendSwatch('tool-exec-bar-p50', 'p50')}${legendSwatch('tool-exec-bar-p95', 'p95')}</div>`;
	const body = rows.length > 0 ? legend + buildLatencyChart(rows) + latencyTable(rows) : emptyHtml('usage.toolExec.empty.latency');
	return sectionHtml('section-tool-latency', '⏱️', 'usage.toolExec.latency.title', 'usage.toolExec.latency.subtitle', body);
}

// ── MCP server health ──────────────────────────────────────────────────────────

interface McpRow { server: string; completed: number; failures: number; }

function mcpRows(mcp: McpToolUsage): McpRow[] {
	const failures = mcp.failuresByServer ?? {};
	return Object.entries(mcp.completedByServer ?? {})
		.filter(([, completed]) => completed > 0)
		.map(([server, completed]) => ({ server, completed, failures: Math.min(completed, failures[server] ?? 0) }))
		.sort((a, b) => b.completed - a.completed)
		.slice(0, TOP_N);
}

function buildMcpHealthChart(rows: McpRow[]): string {
	const plotRight = WIDTH - 150;
	const max = Math.max(1, ...rows.map(r => r.completed));
	const height = TOP_PAD + rows.length * ROW_H + BOTTOM_PAD;
	const x = (v: number) => PLOT_LEFT + (v / max) * (plotRight - PLOT_LEFT);
	const grid = [0.5, 1].map(f => {
		const gx = x(max * f);
		return `<line x1="${gx}" y1="${TOP_PAD}" x2="${gx}" y2="${height - BOTTOM_PAD + 4}"/><text x="${gx}" y="${height - 8}" text-anchor="middle">${formatCompact(Math.round(max * f))}</text>`;
	}).join('');
	const bars = rows.map((r, i) => {
		const y = TOP_PAD + i * ROW_H + ROW_H / 2;
		const label = escapeHtml(localizeFormat('usage.toolExec.mcpLabel', formatNumber(r.completed), formatFailShare(r.failures, r.completed)));
		return `${rowLabel(y, r.server, r.server)}
			<rect class="tool-exec-bar-mcp" x="${PLOT_LEFT}" y="${y - 8}" width="${Math.max(1, x(r.completed) - PLOT_LEFT)}" height="16" rx="3"><title>${escapeHtml(r.server)}: ${label}</title></rect>
			<text x="${x(r.completed) + 8}" y="${y + 4}">${label}</text>`;
	}).join('');
	return `${svgOpen(height, localize('usage.toolExec.mcp.title'))}<g class="tool-exec-grid">${grid}</g>${bars}</svg></div>`;
}

function mcpTable(rows: McpRow[]): string {
	return toolExecTableHtml<McpRow>('mcp', 'usage.toolExec.mcp.title', [
		{ key: 'usage.toolExec.col.server', sortValue: r => r.server, render: r => r.server },
		COMPLETED_COLUMN, FAILED_COLUMN, FAIL_RATE_COLUMN,
	], rows);
}

export function buildMcpHealthSectionHtml(input: ToolExecutionSectionsInput): string {
	const rows = mcpRows(input.mcpTools);
	const body = rows.length > 0 ? buildMcpHealthChart(rows) + mcpTable(rows) : emptyHtml('usage.toolExec.empty.mcp');
	return sectionHtml('section-mcp-health', '🩺', 'usage.toolExec.mcp.title', 'usage.toolExec.mcp.subtitle', body);
}

// ── Cost vs speed ──────────────────────────────────────────────────────────────

interface CostSpeedRow { id: string; name: string; completed: number; p50: number; tokensPerCall: number; kind: ToolKind; }

function costSpeedRows(input: ToolExecutionSectionsInput): CostSpeedRow[] {
	const latency = input.toolCalls.latencyByTool ?? {};
	const tokens = input.toolCalls.outputTokensByTool ?? {};
	const rows: CostSpeedRow[] = [];
	for (const [id, completed] of Object.entries(input.toolCalls.completedByTool ?? {})) {
		const h = latency[id];
		const out = tokens[id] ?? 0;
		if (!isReportableTool(id, input.hiddenTools) || !h || h.count <= 0 || out <= 0 || completed <= 0) { continue; }
		const p50 = latencyPercentileMs(h, 0.5);
		if (p50 === null) { continue; }
		rows.push({ id, name: input.resolveToolName(id), completed, p50: Math.max(1, p50), tokensPerCall: Math.max(1, out / completed), kind: classifyToolKind(id) });
	}
	return rows.sort((a, b) => b.completed - a.completed);
}

const CS = { w: WIDTH, h: 380, left: 80, right: 40, top: 24, bottom: 46 } as const;

function costSpeedAxes(xMin: number, xMax: number, yMin: number, yMax: number): string {
	const plotBottom = CS.h - CS.bottom;
	const xTicks = LATENCY_TICKS.filter(t => t >= xMin && t <= xMax).map(t => {
		const gx = logPos(t, xMin, xMax, CS.left, CS.w - CS.right);
		return `<line x1="${gx}" y1="${CS.top}" x2="${gx}" y2="${plotBottom}"/><text x="${gx}" y="${plotBottom + 16}" text-anchor="middle">${formatLatencyMs(t)}</text>`;
	}).join('');
	const yTicks: string[] = [];
	for (let p = Math.log10(yMin); p <= Math.log10(yMax) + 1e-9; p++) {
		const v = 10 ** p;
		const gy = plotBottom - (logPos(v, yMin, yMax, 0, plotBottom - CS.top));
		yTicks.push(`<line x1="${CS.left}" y1="${gy}" x2="${CS.w - CS.right}" y2="${gy}"/><text x="${CS.left - 8}" y="${gy + 4}" text-anchor="end">${formatCompact(v)}</text>`);
	}
	return `<g class="tool-exec-grid">${xTicks}${yTicks.join('')}</g>
		<text class="tool-exec-axis-title" x="${(CS.left + CS.w - CS.right) / 2}" y="${CS.h - 8}" text-anchor="middle">${escapeHtml(localize('usage.toolExec.axis.latency'))}</text>
		<text class="tool-exec-axis-title" x="14" y="${(CS.top + plotBottom) / 2}" text-anchor="middle" transform="rotate(-90 14 ${(CS.top + plotBottom) / 2})">${escapeHtml(localize('usage.toolExec.axis.tokens'))}</text>
		<text class="tool-exec-chart-hint" x="${CS.w - CS.right}" y="${CS.top - 8}" text-anchor="end">${escapeHtml(localize('usage.toolExec.costSpeed.hint'))}</text>`;
}

function buildCostSpeedChart(rows: CostSpeedRow[]): string {
	const xMin = 1;
	const xMax = ceilToTick(Math.max(10, ...rows.map(r => r.p50)), LATENCY_TICKS);
	const yMin = 10 ** Math.floor(Math.log10(Math.min(...rows.map(r => r.tokensPerCall))));
	const yMax = 10 ** Math.ceil(Math.log10(Math.max(10, ...rows.map(r => r.tokensPerCall))));
	const maxCalls = Math.max(1, ...rows.map(r => r.completed));
	const plotBottom = CS.h - CS.bottom;
	// Largest bubbles first so small ones stay hoverable on top.
	const bubbles = [...rows].sort((a, b) => b.completed - a.completed).map(r => {
		const cx = logPos(r.p50, xMin, xMax, CS.left, CS.w - CS.right);
		const cy = plotBottom - logPos(r.tokensPerCall, yMin, yMax, 0, plotBottom - CS.top);
		const radius = 4 + 20 * Math.sqrt(r.completed / maxCalls);
		const tip = escapeHtml(localizeFormat('usage.toolExec.tip.costSpeed', r.name, localize(`usage.toolExec.kind.${r.kind}`), formatLatencyMs(r.p50), formatNumber(Math.round(r.tokensPerCall)), formatNumber(r.completed)));
		return `<g><circle class="tool-exec-bubble tool-exec-kind-${r.kind}" cx="${cx}" cy="${cy}" r="${radius.toFixed(1)}"><title>${tip}</title></circle>
			<text class="tool-exec-bubble-label" x="${(cx + radius + 4).toFixed(1)}" y="${(cy + 3.5).toFixed(1)}">${escapeHtml(r.name)}</text></g>`;
	}).join('');
	return `${svgOpen(CS.h, localize('usage.toolExec.costSpeed.title'))}${costSpeedAxes(xMin, xMax, yMin, yMax)}${bubbles}</svg></div>`;
}

function costSpeedTable(rows: CostSpeedRow[]): string {
	return toolExecTableHtml<CostSpeedRow>('cost-speed', 'usage.toolExec.costSpeed.title', [
		TOOL_COLUMN,
		{ key: 'usage.toolExec.col.kind', sortValue: r => localize(`usage.toolExec.kind.${r.kind}`), render: r => localize(`usage.toolExec.kind.${r.kind}`) },
		COMPLETED_COLUMN,
		{ key: 'usage.toolExec.col.p50', numeric: true, sortValue: r => r.p50, render: r => formatLatencyMs(r.p50) },
		{ key: 'usage.toolExec.col.tokensPerCall', numeric: true, sortValue: r => r.tokensPerCall, render: r => formatNumber(Math.round(r.tokensPerCall)) },
	], rows);
}

/**
 * Kinds the cost-vs-speed map can show. MCP is deliberately absent: MCP outcomes
 * are recorded per server (MCP server health) and MCP result tokens are not sized,
 * so an MCP bubble has no y value — the legend and copy say builtin / subagent / skill.
 */
const COST_SPEED_KINDS = ['builtin', 'subagent', 'skill'] as const;

export function buildCostSpeedSectionHtml(input: ToolExecutionSectionsInput): string {
	const rows = costSpeedRows(input);
	const kinds = COST_SPEED_KINDS.filter(k => rows.some(r => r.kind === k));
	const legend = `<div class="tool-exec-legend">${kinds.map(k => legendSwatch(`tool-exec-kind-${k}`, localize(`usage.toolExec.kind.${k}`))).join('')}</div>`;
	const body = rows.length > 0 ? legend + buildCostSpeedChart(rows) + costSpeedTable(rows) : emptyHtml('usage.toolExec.empty.costSpeed');
	return sectionHtml('section-tool-cost-speed', '🗺️', 'usage.toolExec.costSpeed.title', 'usage.toolExec.costSpeed.subtitle', body);
}

/** All four sections, in reading order. */
export function buildToolExecutionSectionsHtml(input: ToolExecutionSectionsInput): string {
	return buildToolReliabilitySectionHtml(input)
		+ buildToolLatencySectionHtml(input)
		+ buildMcpHealthSectionHtml(input)
		+ buildCostSpeedSectionHtml(input);
}
