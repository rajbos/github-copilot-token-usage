/**
 * Webview HTML for the Session Efficiency view.
 *
 * The webview ships the full session list as a JSON blob inlined into the
 * page (no external fetch — VS Code webviews don't have file:// access by
 * default). All rendering happens client-side so filtering and sorting feel
 * snappy.
 */

import type { SessionEfficiency } from './sessionEfficiency';

const CATEGORY_LEGEND = [
	{ id: 'shipped',     label: 'shipped',     desc: 'Created at least one PR' },
	{ id: 'committed',   label: 'committed',   desc: 'Committed but no PR opened' },
	{ id: 'issue',       label: 'issue',       desc: 'Created or opened an issue' },
	{ id: 'edited',      label: 'edited',      desc: 'Edited files but no commit' },
	{ id: 'exploratory', label: 'exploratory', desc: 'Few tool calls, no edits — research/Q&A' },
	{ id: 'no-pr',       label: 'no-pr',       desc: 'Heavy session (≥50 tool calls), no PR opened — work may have been pasted elsewhere or used in another session' },
];

export function renderSessionEfficiencyHtml(sessions: SessionEfficiency[]): string {
	// Pre-compress: drop verbose ref objects we don't render.
	const slim = sessions.map(s => ({
		id: s.id,
		repo: s.repository || '',
		branch: s.branch || '',
		summary: s.summary || '',
		firstUserMsg: s.firstUserMsg || '',
		category: s.category,
		userTurns: s.userTurns,
		toolCalls: s.toolCalls,
		commitCount: s.commitCount,
		filesEdited: s.filesEdited,
		prsCreated: s.prsCreated,
		issuesCreated: s.issuesCreated,
		output: s.output,
		efficiency: s.efficiency,
		model: s.model || '',
		updatedAt: s.updatedAt,
		topPrs: s.prRefs
			.filter(r => r.confidence >= 2)
			.slice(0, 5)
			.map(r => ({ repo: r.repo, number: r.number })),
	}));

	const dataJson = JSON.stringify(slim).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Session Efficiency</title>
<style>
  body { font: 13px/1.45 var(--vscode-font-family, system-ui, sans-serif);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 14px; }
  h1 { margin: 0 0 6px 0; font-size: 20px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .panel { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
           border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25));
           border-radius: 4px; padding: 10px 12px; margin-bottom: 12px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > .panel { flex: 1 1 320px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
           padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
       cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; font-weight: 600; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .cat { display: inline-block; padding: 1px 7px; border-radius: 10px;
         font-size: 11px; font-weight: 600; white-space: nowrap; }
  .cat-shipped     { background: rgba( 16,128, 64,0.20); color: #2faa64; }
  .cat-committed   { background: rgba( 28, 71,179,0.20); color: #6c8df0; }
  .cat-issue       { background: rgba(204,138,  0,0.22); color: #e2b249; }
  .cat-edited      { background: rgba(127,127,127,0.22); color: var(--vscode-foreground); }
  .cat-exploratory { background: rgba(122, 63,184,0.22); color: #b889e6; }
  .cat-no-pr       { background: rgba(201,122, 20,0.22); color: #ff9d4a; }
  input, select { padding: 4px 6px; font: inherit; margin-right: 6px;
                  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                  border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .legend span { margin-right: 8px; cursor: help; }
  svg { background: var(--vscode-editor-background); display: block;
        border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25)); border-radius: 4px; }
  .gridline { stroke: var(--vscode-panel-border, rgba(127,127,127,0.18)); }
  .axis text { fill: var(--vscode-descriptionForeground); font-size: 10px; }
  .axis-label { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  circle { cursor: pointer; opacity: 0.7; }
  circle:hover { opacity: 1; stroke: var(--vscode-foreground); stroke-width: 1.4; }
  #tooltip { position: fixed; pointer-events: none;
             background: var(--vscode-editorHoverWidget-background, #222);
             color: var(--vscode-editorHoverWidget-foreground, #fff);
             border: 1px solid var(--vscode-editorHoverWidget-border, transparent);
             padding: 6px 8px; border-radius: 3px; font-size: 12px;
             max-width: 360px; display: none; z-index: 10; }
  a { color: var(--vscode-textLink-foreground); }
  code { font-size: 12px; background: rgba(127,127,127,0.15); padding: 0 4px; border-radius: 2px; }
  .empty { padding: 36px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head><body>
<h1>Session Efficiency</h1>
<p class="muted" id="meta"></p>

<div id="empty" class="empty" style="display:none">
  <strong>No Copilot CLI sessions found.</strong><br>
  Looked in <code>~/.copilot/session-state/</code>. This view reads
  <code>events.jsonl</code> from each session directory.
</div>

<div id="root">
  <div class="panel">
    <strong>Output score</strong> = <code>10·PRs + 4·commits + 3·issues + filesEdited</code>.
    <strong>Cost</strong> = total tool calls (proxy for tokens).
    <strong>Efficiency</strong> = output ÷ cost.
    <div class="legend" style="margin-top:6px" id="legend"></div>
  </div>

  <div class="row">
    <div class="panel" style="flex: 2 1 600px">
      <strong>Cost vs Output</strong>
      <span class="muted">— top-left = efficient · bottom-right = heavy with no on-disk output</span>
      <div id="scatter"></div>
    </div>
    <div class="panel" style="flex: 1 1 260px">
      <strong>Sessions by category</strong>
      <table id="cattable"><tbody></tbody></table>
    </div>
  </div>

  <div class="panel">
    <input id="q" placeholder="Filter (repo, branch, summary…)" size="36">
    <select id="cat"><option value="">All categories</option></select>
    <select id="repo"><option value="">All repos</option></select>
    <label style="font-size:12px"><input type="checkbox" id="onlyOutput"> Only sessions with output</label>
    <span class="muted" id="rowcount" style="margin-left:8px"></span>
  </div>

  <div class="panel" style="padding:0">
    <table id="tbl">
      <thead><tr>
        <th data-k="category">Cat</th>
        <th data-k="repo">Repo</th>
        <th>Branch / summary</th>
        <th data-k="prsCreated" class="num">PRs</th>
        <th data-k="commitCount" class="num">Commits</th>
        <th data-k="filesEdited" class="num">Files</th>
        <th data-k="userTurns" class="num">Turns</th>
        <th data-k="toolCalls" class="num">Tool calls</th>
        <th data-k="output" class="num">Output</th>
        <th data-k="efficiency" class="num" title="Output ÷ tool calls × 100">Eff×100</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<div id="tooltip"></div>

<script>
const DATA = ${dataJson};
const LEGEND = ${JSON.stringify(CATEGORY_LEGEND)};
let SORT = { k: 'efficiency', dir: -1 };

function esc(s) {
  return String(s == null ? '' : s).replace(/[<&>"']/g, c => ({ '<':'&lt;','&':'&amp;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function init() {
  document.getElementById('meta').textContent =
    \`\${DATA.length} session(s) scanned from ~/.copilot/session-state/\`;

  if (DATA.length === 0) {
    document.getElementById('root').style.display = 'none';
    document.getElementById('empty').style.display = 'block';
    return;
  }

  // Legend chips + category filter options
  const legendEl = document.getElementById('legend');
  const catSel = document.getElementById('cat');
  for (const c of LEGEND) {
    const span = document.createElement('span');
    span.className = 'cat cat-' + c.id;
    span.textContent = c.label;
    span.title = c.desc;
    legendEl.appendChild(span);
    catSel.appendChild(new Option(c.label, c.id));
  }

  // Repo filter options
  const repos = [...new Set(DATA.map(s => s.repo).filter(Boolean))].sort();
  const repoSel = document.getElementById('repo');
  for (const r of repos) repoSel.appendChild(new Option(r, r));

  renderCatTable();
  renderScatter();
  renderTable();

  ['q','cat','repo','onlyOutput'].forEach(id =>
    document.getElementById(id).addEventListener('input', renderTable));
  document.querySelectorAll('th[data-k]').forEach(th =>
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (SORT.k === k) SORT.dir = -SORT.dir;
      else { SORT.k = k; SORT.dir = (k === 'repo' || k === 'category') ? 1 : -1; }
      renderTable();
    }));
}

function filtered() {
  const q = document.getElementById('q').value.toLowerCase();
  const cat = document.getElementById('cat').value;
  const rp = document.getElementById('repo').value;
  const only = document.getElementById('onlyOutput').checked;
  return DATA.filter(s => {
    if (cat && s.category !== cat) return false;
    if (rp && s.repo !== rp) return false;
    if (only && s.output === 0) return false;
    if (q) {
      const blob = (s.repo + ' ' + s.branch + ' ' + s.summary + ' ' + s.firstUserMsg + ' ' + s.id).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
}

function renderTable() {
  const r = filtered().slice();
  r.sort((a, b) => {
    const k = SORT.k;
    const av = a[k], bv = b[k];
    if (typeof av === 'string') return SORT.dir * av.localeCompare(bv);
    return SORT.dir * (((av || 0) - (bv || 0)) || 0);
  });
  document.getElementById('rowcount').textContent = \`\${r.length} match(es)\`;
  const top = r.slice(0, 500);
  const html = top.map(s => {
    const prCells = s.topPrs.length
      ? s.topPrs.map(p => \`<a href="https://github.com/\${p.repo}/pull/\${p.number}">#\${p.number}</a>\`).join(' ')
      : (s.prsCreated || '');
    return \`<tr>
      <td><span class="cat cat-\${s.category}">\${s.category}</span></td>
      <td>\${esc(s.repo)}</td>
      <td><code>\${esc(s.id).slice(0,8)}</code> · <code>\${esc(s.branch)}</code><br>
          <span class="muted">\${esc(s.summary || s.firstUserMsg).slice(0, 140)}</span></td>
      <td class="num">\${prCells}</td>
      <td class="num">\${s.commitCount || ''}</td>
      <td class="num">\${s.filesEdited || ''}</td>
      <td class="num">\${s.userTurns}</td>
      <td class="num">\${s.toolCalls}</td>
      <td class="num">\${s.output}</td>
      <td class="num">\${(s.efficiency * 100).toFixed(1)}</td>
    </tr>\`;
  }).join('');
  document.querySelector('#tbl tbody').innerHTML = html;
}

function renderCatTable() {
  const counts = {};
  for (const s of DATA) counts[s.category] = (counts[s.category] || 0) + 1;
  const order = LEGEND.map(c => c.id);
  const total = DATA.length;
  document.querySelector('#cattable tbody').innerHTML = order
    .filter(c => counts[c])
    .map(c => \`<tr>
      <td><span class="cat cat-\${c}" title="\${esc((LEGEND.find(x=>x.id===c)||{}).desc)}">\${c}</span></td>
      <td class="num">\${counts[c]}</td>
      <td class="num muted">\${Math.round(counts[c]*100/total)}%</td>
    </tr>\`).join('');
}

function renderScatter() {
  const W = 720, H = 380, M = { l: 50, r: 16, t: 10, b: 36 };
  const data = DATA.filter(s => s.toolCalls > 0);
  if (data.length === 0) { document.getElementById('scatter').innerHTML = '<p class="muted">No data.</p>'; return; }
  const maxCost = Math.max(50,  ...data.map(s => s.toolCalls));
  const maxOut  = Math.max(5,   ...data.map(s => s.output));
  const x = v => M.l + (Math.log10(v + 1) / Math.log10(maxCost + 1)) * (W - M.l - M.r);
  const y = v => H - M.b - (Math.log10(v + 1) / Math.log10(maxOut + 1)) * (H - M.t - M.b);
  const colors = {
    shipped:'#2faa64', committed:'#6c8df0', issue:'#e2b249',
    edited:'#888', exploratory:'#b889e6', 'no-pr':'#ff9d4a',
  };
  const xticks = [1, 10, 100, 1000, 10000].filter(v => v <= maxCost * 1.5);
  const yticks = [0, 1, 5, 10, 50, 100, 500].filter(v => v <= maxOut * 1.5);

  const dots = data.map(s => {
    const r = 3 + Math.min(7, Math.sqrt(s.userTurns || 1));
    return \`<circle cx="\${x(s.toolCalls).toFixed(1)}" cy="\${y(s.output).toFixed(1)}" r="\${r.toFixed(1)}"
              fill="\${colors[s.category] || '#888'}" data-i="\${esc(JSON.stringify(s))}"/>\`;
  }).join('');
  const gridX = xticks.map(v =>
    \`<line class="gridline" x1="\${x(v)}" y1="\${M.t}" x2="\${x(v)}" y2="\${H-M.b}"/>
     <text x="\${x(v)}" y="\${H-M.b+13}" text-anchor="middle">\${v}</text>\`).join('');
  const gridY = yticks.map(v =>
    \`<line class="gridline" x1="\${M.l}" y1="\${y(v)}" x2="\${W-M.r}" y2="\${y(v)}"/>
     <text x="\${M.l-6}" y="\${y(v)+4}" text-anchor="end">\${v}</text>\`).join('');

  const svg = \`<svg viewBox="0 0 \${W} \${H}" width="100%" height="\${H}" class="axis" preserveAspectRatio="xMidYMid meet">
    \${gridX}\${gridY}
    <text class="axis-label" x="\${W/2}" y="\${H-4}" text-anchor="middle">Tool calls (log) →</text>
    <text class="axis-label" x="14" y="\${H/2}" text-anchor="middle" transform="rotate(-90 14 \${H/2})">Output score (log) →</text>
    \${dots}
  </svg>\`;
  const wrap = document.getElementById('scatter');
  wrap.innerHTML = svg;
  const tip = document.getElementById('tooltip');
  wrap.querySelectorAll('circle').forEach(c => {
    c.addEventListener('mouseenter', () => {
      const s = JSON.parse(c.dataset.i);
      const prsHtml = s.topPrs.length
        ? s.topPrs.map(p => '#' + p.number).join(' ')
        : '—';
      tip.innerHTML = \`<strong>\${esc(s.repo)}</strong> · <code>\${esc(s.branch)}</code><br>
        <span class="cat cat-\${s.category}">\${s.category}</span>
        · \${s.toolCalls} tool calls · \${s.userTurns} user turns<br>
        PRs: \${prsHtml} · \${s.commitCount} commit(s) · \${s.filesEdited} file(s) edited<br>
        eff×100 = \${(s.efficiency*100).toFixed(2)}<br>
        <em>\${esc(s.summary || s.firstUserMsg).slice(0, 200)}</em>\`;
      tip.style.display = 'block';
    });
    c.addEventListener('mousemove', e => {
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top  = (e.clientY + 14) + 'px';
    });
    c.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

init();
</script>
</body></html>`;
}
