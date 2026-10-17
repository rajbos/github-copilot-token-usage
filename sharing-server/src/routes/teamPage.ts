import type { TeamInsights, TeamMember } from '../teamInsights.js';

const exact = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const percent = (n: number): string => `${n.toFixed(1)}%`;

function stat(label: string, value: string): string {
	return `<div class="stat-card"><div class="label">${label}</div><div class="value team-value">${value}</div></div>`;
}

function memberCells(member: TeamMember): string {
	return `<td>${exact(member.inputTokens)}</td><td>${exact(member.outputTokens)}</td>
<td>${exact(member.totalTokens)}</td><td>${exact(member.interactions)}</td>
<td>${member.daysActive}</td><td>${exact(member.tokensPerActiveDay)}</td>
<td>${percent(member.sharePercent)}</td><td>${member.cohort ?? 'No activity'}</td>`;
}

/** CSV is explicitly projected too: never export database rows or profile metadata. */
export function teamInsightsCsv(data: TeamInsights): string {
	const rows: (string | number)[][] = [[
		'Period start (UTC)', 'Period end (UTC)', 'Member', 'Rank', 'Input tokens', 'Output tokens',
		'Total tokens', 'Interactions', 'Days active', 'Tokens per active day', 'Team share (%)', 'Cohort',
	]];
	let peer = 0;
	for (const member of data.members) {
		rows.push([
			data.startDay, data.endDay, member.isSelf ? 'You' : `Peer ${++peer}`, member.rank ?? '',
			member.inputTokens, member.outputTokens, member.totalTokens, member.interactions,
			member.daysActive, member.tokensPerActiveDay, member.sharePercent, member.cohort ?? '',
		]);
	}
	return rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
}

function cohortCards(data: TeamInsights): string {
	const { q1, q2, q3 } = data.quartiles;
	const ranges = [
		`Up to ${exact(q1)} tokens`,
		`Above ${exact(q1)}, up to ${exact(q2)}`,
		`Above ${exact(q2)}, up to ${exact(q3)}`,
		`Above ${exact(q3)} tokens`,
	];
	return data.cohorts.map((cohort, i) => `<div class="stat-card">
  <div class="label">${cohort.label}${data.self.cohort === cohort.label ? ' <span class="pill">You</span>' : ''}</div>
  <div class="value">${cohort.members}</div>
  <p class="team-muted">${data.summary.activeUsers ? percent(cohort.members / data.summary.activeUsers * 100) : '0.0%'} of active uploaders</p>
  <meter min="0" max="${Math.max(1, data.summary.activeUsers)}" value="${cohort.members}" aria-label="${cohort.label} uploaders">${cohort.members}</meter>
  <p class="team-muted">${ranges[i]}</p>
</div>`).join('');
}

export function renderTeamInsights(data: TeamInsights): string {
	const { summary, self } = data;
	let peer = 0;
	const rows = data.members.map(member => `<tr${member.isSelf ? ' class="team-self" data-self="true"' : ''}>
  <th scope="row">${member.isSelf ? '<strong>You</strong>' : `Peer ${++peer}`}</th>
  <td>${member.rank ?? '-'}</td>${memberCells(member)}
</tr>`).join('');
	const selfPosition = self.rank === null
		? '<p class="alert alert-warn">You have no active uploads in this period. Upload your usage to see your position; inactive users are not ranked.</p>'
		: `<div class="stat-grid">
${stat('Your total tokens', exact(self.totalTokens))}
${stat('Your token rank', `${self.rank} of ${summary.activeUsers}`)}
${stat('Your share of team tokens', percent(self.sharePercent))}
${stat('Your usage cohort', self.cohort ?? 'No activity')}
</div>
<p class="team-muted">${self.percentile === null
	? 'No other active uploaders in this period yet; a peer percentile is not available.'
	: `Your token total is higher than ${percent(self.percentile)} of the other active uploaders. Equal totals share a rank and cohort.`}</p>`;
	// Only numeric aggregate series and server-generated ISO dates reach chart code.
	const chartData = JSON.stringify(data.daily).replace(/</g, '\\u003c');
	return `
<style>
  .team-page { --team-muted: #8b949e; --team-accent: #58a6ff; --team-grid: #30363d; --team-own: #e3b341; }
  .team-page h2 { margin: 0 0 8px; }
  .team-muted { color: var(--team-muted); font-size: 0.85rem; line-height: 1.5; }
  .team-value { font-size: 1.3rem !important; overflow-wrap: anywhere; line-height: 1.25 !important; }
  .team-page .tab { text-decoration: none; }
  .team-page > .card { min-width: 0; }
  .team-page .chart-wrap { min-width: 0; }
  .team-page meter { width: 100%; accent-color: var(--team-accent); }
  .team-page .team-self { outline: 1px solid var(--team-accent); outline-offset: -1px; }
  .team-page td, .team-page th { font-variant-numeric: tabular-nums; }
  .team-page caption { text-align: left; padding: 8px 0; color: var(--team-muted); }
  .team-page a:not(.tab):not(.btn) { color: var(--team-accent); }
  .team-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  @media (max-width: 720px) {
    .team-value { font-size: 1.05rem !important; }
    .team-actions .btn { flex: 1 1 0; padding: 8px 12px; }
    .team-page .card-header > a { display: inline-flex; align-items: center; min-height: 40px; }
  }
  @media (max-width: 350px) {
    .team-value { font-size: 0.92rem !important; }
  }
</style>
<main class="content team-page">
  <section class="card">
    <div class="card-header">
      <div><h2>Team Insights</h2><span class="team-muted">${data.startDay} to ${data.endDay} &middot; UTC &middot; ${data.days} days including today</span></div>
      <nav class="tabs" aria-label="Team usage period">${[7, 30, 90].map(days =>
		`<a class="tab${data.days === days ? ' active' : ''}" href="/team?days=${days}"${data.days === days ? ' aria-current="page"' : ''}>Last ${days} days</a>`).join('')}</nav>
    </div>
    <p class="team-muted">Your uploaded usage in context, compared with active uploaders on this server. Usage volume is not productivity, skill, or fluency.</p>
    <div class="alert alert-warn"><strong>Names are hidden, not guaranteed anonymous.</strong>
      Exact usage patterns may identify a teammate, especially in small teams. Peer numbers below are row labels, not persistent identities.
      Profiles, workspaces, machines, and individual peer timelines are never included in this view or its exports.</div>
  </section>

  <section class="card" aria-labelledby="team-overview">
    <div class="card-header"><h3 id="team-overview">Team overview</h3></div>
    <div class="stat-grid">
      ${stat('Active uploaders', exact(summary.activeUsers))}
      ${stat('Total tokens', exact(summary.totalTokens))}
      ${stat('Input tokens', exact(summary.inputTokens))}
      ${stat('Output tokens', exact(summary.outputTokens))}
      ${stat('Interactions', exact(summary.interactions))}
      ${stat('Mean tokens / uploader', exact(summary.averageTokens))}
      ${stat('Median tokens / uploader', exact(summary.medianTokens))}
    </div>
    <p class="team-muted">Active means positive tokens or interactions in this period. Totals reflect uploaded data, not necessarily all usage. Means and medians include you when active.</p>
  </section>

  <section class="card" aria-labelledby="your-position">
    <div class="card-header"><h3 id="your-position">Where you stand</h3><a href="/dashboard">Your detailed dashboard</a></div>
    ${selfPosition}
  </section>

  <section class="card" aria-labelledby="team-cohorts">
    <div class="card-header"><h3 id="team-cohorts">Usage cohorts</h3></div>
    ${summary.activeUsers ? `<div class="stat-grid">${cohortCards(data)}</div>` : '<p>No active uploads in this period yet.</p>'}
    <p class="team-muted">Relative to this team, not fixed usage limits: Light / Medium / Heavy / Very heavy are split at the interpolated 25th, 50th, and 75th percentiles of total tokens.
      A boundary value belongs to the lower cohort. Ties are kept together, so cohorts may be uneven or empty.
      Small samples are not representative; cohorts may change with the period or new uploads.</p>
  </section>

  <section class="card" aria-labelledby="team-trend">
    <div class="card-header"><h3 id="team-trend">Usage trend</h3>
      <div class="tabs" aria-label="Trend comparison">
        <button type="button" class="tab active" data-team-mode="total" aria-pressed="true">Team total</button>
        <button type="button" class="tab" data-team-mode="average" aria-pressed="false">Per-user average</button>
      </div>
    </div>
    <p class="team-muted">Compare your tokens with the team total or the mean per active uploader on each UTC day. No individual peer series.</p>
    <div class="chart-wrap"><canvas id="team-trend-chart" role="img" aria-label="Your daily tokens compared with team usage. Exact values are in Daily raw numbers below."></canvas></div>
    <p id="team-chart-unavailable" class="team-muted" hidden>The chart is unavailable. All values remain available in Daily raw numbers below.</p>
    <details id="team-daily-numbers">
      <summary>Daily raw numbers</summary>
      <div class="table-scroll"><table class="sticky-first">
        <caption>Exact team totals and your own tokens by UTC day</caption>
        <thead><tr><th scope="col">Day (UTC)</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Total tokens</th><th scope="col">Interactions</th><th scope="col">Active uploaders</th><th scope="col">Your tokens</th></tr></thead>
        <tbody>${data.daily.map(day => `<tr><th scope="row">${day.day}</th><td>${exact(day.inputTokens)}</td><td>${exact(day.outputTokens)}</td><td>${exact(day.totalTokens)}</td><td>${exact(day.interactions)}</td><td>${day.activeUsers}</td><td>${exact(day.ownTokens)}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>
  </section>

  <section class="card" aria-labelledby="team-members">
    <div class="card-header"><h3 id="team-members">Raw numbers by active uploader</h3>
      <div class="team-actions">
        <a class="btn btn-secondary" href="/team/export?days=${data.days}&amp;format=csv">Download CSV</a>
        <a class="btn btn-secondary" href="/team/export?days=${data.days}&amp;format=json">Download JSON</a>
      </div>
    </div>
    <p class="team-muted">Sorted by total tokens, highest first. Peer labels only identify rows in this result; they cannot be used to open another person's data.
      CSV contains this table; JSON also includes the team overview, comparisons, cohorts, and daily team/own totals.</p>
    ${data.members.length ? `<div class="table-scroll"><table id="team-member-table" class="sticky-first">
      <caption>Full token counts, not rounded K / M / B abbreviations. Derived averages are shown to two decimals and shares to one.</caption>
      <thead><tr><th scope="col">Member</th><th scope="col">Rank</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Total tokens</th><th scope="col">Interactions</th><th scope="col">Days active</th><th scope="col">Tokens / active day</th><th scope="col">Team share</th><th scope="col">Cohort</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : '<p>No active uploaders in this period. Your uploads will appear here once available.</p>'}
  </section>
</main>
<script>
(function () {
  var daily = ${chartData};
  var buttons = document.querySelectorAll('[data-team-mode]');
  if (typeof Chart === 'undefined') {
    document.getElementById('team-chart-unavailable').hidden = false;
    document.getElementById('team-trend-chart').hidden = true;
    buttons.forEach(function(button) { button.disabled = true; });
    return;
  }
  var style = getComputedStyle(document.querySelector('.team-page'));
  var accent = style.getPropertyValue('--team-accent').trim();
  var own = style.getPropertyValue('--team-own').trim();
  var muted = style.getPropertyValue('--team-muted').trim();
  var grid = style.getPropertyValue('--team-grid').trim();
  var narrowQuery = window.matchMedia('(max-width: 720px)');
  var narrow = narrowQuery.matches;
  var chart = new Chart(document.getElementById('team-trend-chart'), {
    type: 'line',
    data: {
      labels: daily.map(function(day) { return day.day; }),
      datasets: [
        { label: 'Team total', data: daily.map(function(day) { return day.totalTokens; }), borderColor: accent, backgroundColor: accent, borderWidth: 2, pointRadius: 2 },
        { label: 'You', data: daily.map(function(day) { return day.ownTokens; }), borderColor: own, backgroundColor: own, borderWidth: 2, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: muted, maxTicksLimit: narrow ? 6 : 12 }, grid: { color: grid } },
        y: { beginAtZero: true, ticks: { color: muted }, grid: { color: grid }, title: { display: !narrow, text: 'Tokens', color: muted } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: muted } },
        tooltip: { callbacks: { label: function(context) { return context.dataset.label + ': ' + context.parsed.y.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' tokens'; } } }
      }
    }
  });
  // Re-evaluated when the width crosses the breakpoint, e.g. on rotating the phone.
  narrowQuery.addEventListener('change', function(e) {
    narrow = e.matches;
    chart.options.scales.x.ticks.maxTicksLimit = narrow ? 6 : 12;
    chart.options.scales.y.title.display = !narrow;
    chart.update();
  });
  buttons.forEach(function(button) {
    button.addEventListener('click', function() {
      var average = button.getAttribute('data-team-mode') === 'average';
      buttons.forEach(function(item) {
        item.classList.toggle('active', item === button);
        item.setAttribute('aria-pressed', String(item === button));
      });
      chart.data.datasets[0].label = average ? 'Mean per daily active uploader' : 'Team total';
      chart.data.datasets[0].data = daily.map(function(day) {
        return average ? (day.activeUsers ? day.totalTokens / day.activeUsers : 0) : day.totalTokens;
      });
      chart.update();
    });
  });
})();
</script>`;
}
