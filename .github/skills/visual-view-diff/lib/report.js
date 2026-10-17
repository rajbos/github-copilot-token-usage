'use strict';

/**
 * Renders the comparison result as Markdown.
 *
 * The output is written to a file and nothing more. It is shaped so that a
 * separate step (a PR comment, a job summary, a CI artifact index) can use it
 * as-is, but this skill never publishes it — deciding what changed visually and
 * telling somebody about it are separate concerns, and only the first one
 * belongs here.
 *
 * Image links are left as bare file names relative to the diff directory,
 * because whoever publishes the report knows where the files ended up (an
 * artifact URL, an uploaded asset) and this code does not.
 */

function formatPercent(value) {
	if (value === 0) { return '0%'; }
	if (value < 0.01) { return '<0.01%'; }
	return `${value.toFixed(2)}%`;
}

/**
 * A percentage alone is misleading for a small change on a tall screenshot — a
 * restyled badge is a real change that rounds to "<0.01%" — so the raw pixel
 * count is always shown alongside it.
 */
function formatChange(comparison) {
	return `${formatPercent(comparison.changedPercent)} (${comparison.changedPixels.toLocaleString('en-US')} px)`;
}

function renderMarkdownReport(report) {
	const { summary, comparisons, threshold } = report;
	const lines = [];

	lines.push('## Visual view changes', '');

	if (summary.changed === 0 && summary.added === 0 && summary.removed === 0) {
		lines.push(`No visual changes: all ${summary.unchanged} view screenshots are pixel-identical to the baseline.`, '');
		lines.push(`<sub>Compared at a per-channel threshold of ${threshold}.</sub>`, '');
		return lines.join('\n');
	}

	const parts = [];
	if (summary.changed) { parts.push(`**${summary.changed} changed**`); }
	if (summary.added) { parts.push(`${summary.added} added`); }
	if (summary.removed) { parts.push(`${summary.removed} removed`); }
	if (summary.unchanged) { parts.push(`${summary.unchanged} unchanged`); }
	lines.push(parts.join(' · '), '');

	lines.push('| View | State | Theme | Status | Pixels changed | Size |');
	lines.push('| --- | --- | --- | --- | --- | --- |');
	for (const c of comparisons) {
		const status = {
			changed: '🎨 changed',
			unchanged: '⚪ unchanged',
			added: '🆕 added',
			removed: '🗑️ removed',
		}[c.status];
		const pixels = c.status === 'changed' ? formatChange(c) : '—';
		const size = c.resized ? `${c.baselineSize} → ${c.currentSize}` : (c.currentSize || '—');
		lines.push(`| \`${c.view}\` | ${c.state || 'initial'} | ${c.theme} | ${status} | ${pixels} | ${size} |`);
	}
	lines.push('');

	const changed = comparisons.filter((c) => c.status === 'changed');
	if (changed.length > 0) {
		lines.push('### Changed views', '');
		for (const c of changed) {
			lines.push(`<details><summary><code>${c.view}</code>${c.state ? ` (${c.state})` : ''} — ${c.theme} (${formatChange(c)} changed)</summary>`, '');
			lines.push(`| Before | After | Diff |`);
			lines.push(`| --- | --- | --- |`);
			// Baseline and current screenshots share a file name and are told apart
			// by their directory, so the directory has to stay in the link.
			lines.push(`| baseline/${c.baseline} | current/${c.current} | diff/${c.diff} |`);
			lines.push('', '</details>', '');
		}
	}

	lines.push(
		`<sub>Rendered headlessly from committed fixtures at a per-channel threshold of ${threshold}. ` +
		'Screenshots show the real webview bundles, not a mock-up.</sub>',
		'',
	);
	return lines.join('\n');
}

module.exports = { renderMarkdownReport };
