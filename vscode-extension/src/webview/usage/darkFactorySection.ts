/**
 * Renders the per-repository Dark Factory readiness scan in Usage Analysis.
 *
 * Unlike the Fluency Score, this scan scores repositories, not people. It
 * contributes nothing to the personal radar or overall stage.
 *
 * Pure string building — no DOM access, no messaging — so it can be unit
 * tested directly.
 */
import { escapeHtml } from '../shared/formatUtils';
import { localize, localizeFormat } from '../shared/localization';
import { DARK_FACTORY_DISCLAIMER, nextStageToClose } from '../../../../src/darkFactoryReadiness';
import type {
	DarkFactoryControlResult,
	DarkFactoryFinding,
	DarkFactoryRepoReport,
	DarkFactoryReport,
	DarkFactoryStageResult,
} from '../../../../src/types';

/**
 * Localize a `{0}`-style template for HTML: the template is escaped, the
 * arguments are inserted as-is, so callers pass only markup they built.
 */
function localizeHtml(key: string, ...htmlArgs: string[]): string {
	return escapeHtml(localize(key)).replace(/\{(\d+)\}/g, (match, index) => htmlArgs[Number(index)] ?? match);
}

/** What a selection box in a repository card refers to. */
export type DarkFactoryPickKind = 'control' | 'finding';

/** Chip label and CSS modifier for each stage verdict. */
const VERDICT_PRESENTATION: Record<DarkFactoryStageResult['verdict'], { label: string; modifier: string }> = {
	attained: { label: 'Attained', modifier: 'df-verdict-attained' },
	blocked: { label: 'Blocked', modifier: 'df-verdict-blocked' },
	indeterminate: { label: 'Unverified', modifier: 'df-verdict-unverified' },
};

const SEVERITY_ICONS: Record<DarkFactoryFinding['severity'], string> = {
	high: '🔴',
	medium: '🟡',
	low: '🟢',
};

/** Look up controls by id, preserving the catalogue order of `ids`. */
function controlsById(controls: readonly DarkFactoryControlResult[], ids: readonly string[]): DarkFactoryControlResult[] {
	return ids
		.map(id => controls.find(control => control.id === id))
		.filter((control): control is DarkFactoryControlResult => control !== undefined);
}

/**
 * The headline band. `confirmedStage` is a lower bound and `ceilingStage` an
 * upper one, so the two are always shown together when they differ — a single
 * number would imply evidence the scan does not have.
 */
function buildBandHtml(repo: DarkFactoryRepoReport): string {
	if (repo.fullyEvidenced) {
		return `<div class="df-band df-band-complete">
			<span class="df-band-stage">Stage ${repo.confirmedStage}</span>
			<span class="df-band-note">every control observed</span>
		</div>`;
	}
	const ceiling = repo.ceilingStage > repo.confirmedStage
		? `<span class="df-band-note">up to Stage ${repo.ceilingStage} unverified &middot; ${repo.unknownCount} control(s) not checked</span>`
		: `<span class="df-band-note">${repo.unknownCount} control(s) not checked</span>`;
	return `<div class="df-band">
		<span class="df-band-stage">Stage ${repo.confirmedStage} confirmed</span>
		${ceiling}
	</div>`;
}

/** Checked-by-default box that selects an item for the Copilot Chat prompt. */
function buildPickHtml(kind: DarkFactoryPickKind, id: string, label: string): string {
	return `<input type="checkbox" class="df-pick" data-df-kind="${kind}" data-df-id="${escapeHtml(id)}" checked aria-label="${escapeHtml(localizeFormat('readiness.action.includeItem', label))}">`;
}

/**
 * One control rendered as its label plus why it matters or what to do about it.
 * Actionable controls (missing ones) get a selection box; unchecked ones do not,
 * since there is nothing concrete to implement until their state is known.
 */
function buildControlItemHtml(control: DarkFactoryControlResult, secondLine: string, actionable = false): string {
	const heuristic = control.evidence === 'heuristic'
		? ' <span class="df-heuristic" title="Detected by pattern matching — a candidate, not a verdict">heuristic</span>'
		: '';
	const pick = actionable ? buildPickHtml('control', control.id, control.label) : '';
	return `<li${actionable ? ' class="df-pickable"' : ''}>
		${pick}<span class="df-item-text">
			<span class="df-control-label">${escapeHtml(control.label)}</span>${heuristic}
			<span class="df-control-detail">${escapeHtml(secondLine)}</span>
		</span>
	</li>`;
}

/** The controls blocking the next stage, with the concrete remediation for each. */
function buildBlockersHtml(stage: DarkFactoryStageResult, controls: readonly DarkFactoryControlResult[]): string {
	if (stage.missing.length === 0) { return ''; }
	const items = controlsById(controls, stage.missing)
		.map(control => buildControlItemHtml(control, control.remediation, true))
		.join('');
	return `<div class="df-block">
		<div class="df-block-title">Missing for Stage ${stage.stage} &mdash; ${escapeHtml(stage.name)}</div>
		<ul class="df-control-list">${items}</ul>
	</div>`;
}

/** The controls the scan could not determine, each with the reason it could not. */
function buildUnknownsHtml(stage: DarkFactoryStageResult, controls: readonly DarkFactoryControlResult[]): string {
	if (stage.unknown.length === 0) { return ''; }
	const items = controlsById(controls, stage.unknown)
		.map(control => buildControlItemHtml(control, control.detail ?? 'State could not be determined.'))
		.join('');
	return `<div class="df-block df-block-unknown">
		<div class="df-block-title">Could not check for Stage ${stage.stage}</div>
		<ul class="df-control-list">${items}</ul>
	</div>`;
}

function buildStageChipsHtml(repo: DarkFactoryRepoReport): string {
	const chips = repo.stages.map(stage => {
		const presentation = VERDICT_PRESENTATION[stage.verdict];
		const title = `${stage.name} — ${stage.summary}`;
		return `<span class="df-chip ${presentation.modifier}" title="${escapeHtml(title)}">
			<span class="df-chip-stage">${stage.stage}</span>${escapeHtml(presentation.label)}
		</span>`;
	}).join('');
	return `<div class="df-chips">${chips}</div>`;
}

function buildFindingsHtml(findings: readonly DarkFactoryFinding[]): string {
	if (findings.length === 0) { return ''; }
	const items = findings.map(finding => `<li class="df-pickable">
		${buildPickHtml('finding', finding.id, finding.title)}<span class="df-item-text">
			<span class="df-finding-title">${SEVERITY_ICONS[finding.severity]} ${escapeHtml(finding.title)}</span>
			<span class="df-control-detail">${escapeHtml(finding.detail)}</span>
		</span>
	</li>`).join('');
	return `<div class="df-block df-block-findings">
		<div class="df-block-title">Anti-patterns detected</div>
		<ul class="df-control-list">${items}</ul>
	</div>`;
}

/** Compact per-stage verdict dots for the collapsed summary row. */
function buildStageDotsHtml(repo: DarkFactoryRepoReport): string {
	const dots = repo.stages.map(stage => {
		const presentation = VERDICT_PRESENTATION[stage.verdict];
		const title = `Stage ${stage.stage}: ${presentation.label} — ${stage.name}`;
		return `<span class="df-dot ${presentation.modifier}" title="${escapeHtml(title)}">${stage.stage}</span>`;
	}).join('');
	return `<span class="df-dots">${dots}</span>`;
}

/** Short headline for the summary row; the full band is shown when expanded. */
function buildSummaryStageText(repo: DarkFactoryRepoReport): string {
	return repo.fullyEvidenced
		? `Stage ${repo.confirmedStage}`
		: `Stage ${repo.confirmedStage} confirmed`;
}

/** "3 missing · 9 unchecked · 1 anti-pattern" — the counts that decide whether to dive in. */
function buildSummaryCountsHtml(repo: DarkFactoryRepoReport, nextStage: DarkFactoryStageResult | undefined): string {
	const parts: string[] = [];
	if (nextStage && nextStage.missing.length > 0) {
		parts.push(`<span class="df-count df-count-missing">${escapeHtml(localizeFormat('readiness.summary.missingForStage', nextStage.missing.length, nextStage.stage))}</span>`);
	}
	if (repo.unknownCount > 0) {
		parts.push(`<span class="df-count df-count-unknown">${escapeHtml(localizeFormat('readiness.summary.unchecked', repo.unknownCount))}</span>`);
	}
	if (repo.findings.length > 0) {
		const key = repo.findings.length === 1 ? 'readiness.summary.antiPattern' : 'readiness.summary.antiPatterns';
		parts.push(`<span class="df-count df-count-findings">${escapeHtml(localizeFormat(key, repo.findings.length))}</span>`);
	}
	return `<span class="df-counts">${parts.join('')}</span>`;
}

/** The button that drafts a Copilot Chat prompt from the selected items. */
function buildActionHtml(repoIndex: number, nextStage: DarkFactoryStageResult | undefined, repo: DarkFactoryRepoReport): string {
	const actionable = (nextStage?.missing.length ?? 0) + repo.findings.length;
	if (actionable === 0) { return ''; }
	return `<div class="df-action">
		<span class="df-action-text">${escapeHtml(localize('readiness.action.hint'))}</span>
		<button class="button df-chat-btn" data-df-repo="${repoIndex}">${escapeHtml(localize('readiness.action.draft'))}</button>
	</div>`;
}

function buildRepoCardHtml(repo: DarkFactoryRepoReport, repoIndex: number): string {
	// The first stage above the confirmed one is the only actionable target;
	// listing every unattained stage's gaps at once buries it.
	const nextStage = nextStageToClose(repo);
	const identity = repo.nameWithOwner
		? `<span class="df-repo-owner">${escapeHtml(repo.nameWithOwner)}</span>`
		: `<span class="df-repo-owner df-repo-owner-unknown">local repository &mdash; no GitHub remote resolved</span>`;

	// Collapsed by default so the tab reads as an overview across all
	// repositories; each row expands to the full band, blockers and findings.
	return `<details class="df-repo-card" data-df-repo="${repoIndex}">
		<summary class="df-repo-summary">
			<span class="df-repo-head">
				<span class="df-repo-name">${escapeHtml(repo.name)}</span>
				${identity}
			</span>
			<span class="df-summary-stage">${buildSummaryStageText(repo)}</span>
			${buildStageDotsHtml(repo)}
			${buildSummaryCountsHtml(repo, nextStage)}
		</summary>
		<div class="df-repo-body">
			${buildBandHtml(repo)}
			${buildStageChipsHtml(repo)}
			${nextStage ? buildBlockersHtml(nextStage, repo.controls) : ''}
			${nextStage ? buildUnknownsHtml(nextStage, repo.controls) : ''}
			${buildFindingsHtml(repo.findings)}
			${buildActionHtml(repoIndex, nextStage, repo)}
		</div>
	</details>`;
}

/** One-line tally across every scanned repository, shown above the rows. */
function buildOverviewHtml(repos: readonly DarkFactoryRepoReport[]): string {
	const byStage = new Map<number, number>();
	for (const repo of repos) {
		byStage.set(repo.confirmedStage, (byStage.get(repo.confirmedStage) ?? 0) + 1);
	}
	const stages = [...byStage.entries()]
		.sort(([a], [b]) => b - a)
		.map(([stage, count]) => `<span class="df-overview-item">${localizeHtml('readiness.overview.atStage', `<strong>${count}</strong>`, String(stage))}</span>`)
		.join('');
	const withFindings = repos.filter(repo => repo.findings.length > 0).length;
	const findings = withFindings > 0
		? `<span class="df-overview-item">${localizeHtml('readiness.overview.withAntiPatterns', `<strong>${withFindings}</strong>`)}</span>`
		: '';
	const scannedKey = repos.length === 1 ? 'readiness.overview.scannedOne' : 'readiness.overview.scannedMany';
	return `<div class="df-overview">
		<span class="df-overview-item">${localizeHtml(scannedKey, `<strong>${repos.length}</strong>`)}</span>
		${stages}
		${findings}
		<span class="df-overview-hint">${escapeHtml(localize('readiness.overview.hint'))}</span>
	</div>`;
}

function buildEvidenceNoticeHtml(report: DarkFactoryReport): string {
	const apiNote = report.apiSignalsIncluded
		? 'Pull-request evidence from the Usage Analysis view is included.'
		: 'No GitHub API evidence was available, so rulesets, required reviews, environment protection and scanning enablement are all reported as unchecked rather than missing.';
	const skippedCount = report.skippedRepoCount;
	const skipped = skippedCount > 0
		? ` ${skippedCount} further ${skippedCount === 1 ? 'repository was' : 'repositories were'} found but not scanned in this run.`
		: '';
	return `<div class="df-notice">${apiNote}${skipped}</div>`;
}

/**
 * Build the whole section. Returns an empty string when no report is available
 * — an absent scan is not the same as a repository with no controls, and this
 * view should say nothing rather than imply the latter.
 */
export function buildDarkFactorySectionHtml(report: DarkFactoryReport | undefined): string {
	if (!report) { return ''; }

	const body = report.repos.length === 0
		? `<div class="df-empty">No git repositories were found in this workspace, so there is nothing to assess. This scan reads repositories, never people.</div>`
		: buildOverviewHtml(report.repos) + report.repos.map((repo, index) => buildRepoCardHtml(repo, index)).join('');

	return `
		<div class="df-section">
			<div class="df-section-head">
				<span class="df-section-icon">🏭</span>
				<span class="df-section-title">Dark Factory Readiness</span>
				<span class="df-section-badge">per repository</span>
			</div>
			<div class="df-disclaimer">
				<strong>${escapeHtml(localize('readiness.disclaimer.headline'))}</strong> ${escapeHtml(localize('readiness.disclaimer.body'))}
			</div>
			<details class="df-about">
				<summary>${escapeHtml(localize('readiness.about.title'))}</summary>
				<div class="df-about-body">
					A dark factory is a governed, observable production system &mdash; humans specify intent, constraints, risk and
					evidence of success while agents implement and validate. This section reports which of those governance and
					evidence controls each repository in your workspace actually has, and the specific ones blocking the next stage.
					<br><br>
					${escapeHtml(localize('readiness.about.weakEvidence'))} ${escapeHtml(DARK_FACTORY_DISCLAIMER)}
					${escapeHtml(localize('readiness.about.stage5'))}
				</div>
			</details>
			${buildEvidenceNoticeHtml(report)}
			${body}
			<div class="df-footer">Scanned ${escapeHtml(new Date(report.scannedAt).toLocaleString())} &middot; Stages 1&ndash;${report.maxAssessableStage} are assessable; Stage 5 is not.</div>
		</div>
	`;
}

/**
 * The Copilot Chat prompt for the items a user picked in one repository card.
 * Unknown ids are ignored, so a stale selection cannot inject arbitrary text:
 * every line comes from the report, never from the DOM.
 */
export function buildDarkFactoryChatPrompt(
	repo: DarkFactoryRepoReport,
	controlIds: readonly string[],
	findingIds: readonly string[],
): string | undefined {
	const controls = controlsById(repo.controls, controlIds).filter(control => control.state === 'absent');
	const findings = findingIds
		.map(id => repo.findings.find(finding => finding.id === id))
		.filter((finding): finding is DarkFactoryFinding => finding !== undefined);
	if (controls.length === 0 && findings.length === 0) { return undefined; }

	const target = repo.nameWithOwner ? `${repo.nameWithOwner} (${repo.repoRoot})` : repo.repoRoot;
	const lines: string[] = [
		`Help me strengthen the governance and evidence controls in the repository ${target}.`,
		'A Dark Factory readiness scan flagged the items below. Implement them as focused, reviewable changes.',
	];
	if (controls.length > 0) {
		lines.push('', 'Missing controls:');
		for (const control of controls) {
			lines.push(`- ${control.label} (Stage ${control.stage}): ${control.remediation}${control.why ? ` Why: ${control.why}` : ''}`);
		}
	}
	if (findings.length > 0) {
		lines.push('', 'Anti-patterns to fix:');
		for (const finding of findings) {
			lines.push(`- [${finding.severity}] ${finding.title}: ${finding.detail}`);
		}
	}
	lines.push(
		'',
		'Look at the existing repository layout and conventions first, and ask me before changing anything that needs repository or organization settings you cannot edit from files (rulesets, required reviews, environments).',
		'Summarize what you changed and what still needs a human decision. Do not claim the repository is ready to run without human review.',
	);
	return lines.join('\n');
}
