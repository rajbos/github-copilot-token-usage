import { setHtml } from '../shared/domUtils';
import { escapeHtml } from '../shared/formatUtils';

const USAGE_LOADING_CSS = `
<style id="usage-loading-css">
:root {
  --ul-bg: var(--vscode-sideBar-background, #181825);
  --ul-card: var(--vscode-editorWidget-background, #24273a);
  --ul-fg: var(--vscode-editor-foreground, #cdd6f4);
  --ul-muted: var(--vscode-descriptionForeground, #9399b2);
  --ul-accent: var(--vscode-textLink-foreground, #89b4fa);
  --ul-success: var(--vscode-terminal-ansiGreen, #a6e3a1);
  --ul-border: var(--vscode-panel-border, #313244);
  --ul-badge-bg: var(--vscode-badge-background, #313244);
}
#usage-loading-wrap {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  display: flex; align-items: flex-start; justify-content: center; padding: 28px 20px;
}
#usage-loading-card {
  width: 100%; max-width: 680px;
  background: var(--ul-card); border: 1px solid var(--ul-border);
  border-radius: 16px; padding: 24px 28px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3); color: var(--ul-fg);
}
#ul-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; gap: 16px; }
#ul-badge { font-size: 11px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: var(--ul-accent); margin-bottom: 4px; }
#ul-title { font-size: 22px; font-weight: 700; color: var(--ul-fg); margin-bottom: 4px; }
#ul-subtitle { font-size: 12px; color: var(--ul-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
#ul-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
#ul-pct { font-size: 32px; font-weight: 800; color: var(--ul-fg); line-height: 1; min-width: 60px; text-align: right; font-variant-numeric: tabular-nums; }
.ul-meta-badge { font-size: 11px; padding: 3px 10px; border: 1px solid var(--ul-border); border-radius: 20px; color: var(--ul-muted); background: var(--vscode-editor-background, #1e1e2e); white-space: nowrap; }
#ul-track { height: 6px; background: var(--ul-border); border-radius: 3px; overflow: hidden; margin: 16px 0; }
#ul-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--ul-accent), var(--ul-success)); transition: width 0.4s ease; width: 3%; }
#ul-fill.ul-indeterminate { width: 25%; animation: ul-shimmer 1.8s ease-in-out infinite; background: linear-gradient(90deg, transparent, var(--ul-accent), var(--ul-success), transparent); }
@keyframes ul-shimmer { 0% { margin-left: -30%; } 100% { margin-left: 110%; } }
#ul-steps { background: var(--ul-bg); border: 1px solid var(--ul-border); border-radius: 10px; padding: 14px 16px; }
.ul-step { display: flex; align-items: center; gap: 10px; padding: 5px 0; color: var(--ul-muted); font-size: 13px; transition: color 0.25s; }
.ul-step.ul-done   { color: var(--ul-success); }
.ul-step.ul-active { color: var(--ul-accent); font-weight: 600; }
.ul-ico { width: 18px; text-align: center; flex-shrink: 0; }
.ul-spin { display: inline-block; animation: ul-spin 0.75s linear infinite; }
@keyframes ul-spin { to { transform: rotate(360deg); } }
.ul-lbl { flex: 1; }
.ul-cnt { font-size: 11px; opacity: 0.75; font-variant-numeric: tabular-nums; }
@keyframes ul-pop { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.3); } 100% { transform: scale(1); opacity: 1; } }
.ul-pop { animation: ul-pop 0.3s ease both; }
</style>`;

const USAGE_LOADING_STEPS = [
	{ id: 'ul-s-start',  label: 'Starting usage analysis' },
	{ id: 'ul-s-tools',  label: 'Collecting runtime tools' },
	{ id: 'ul-s-mcp',    label: 'Discovering MCP servers' },
	{ id: 'ul-s-skills', label: 'Scanning skill directories' },
	{ id: 'ul-s-crunch', label: 'Computing curation analysis' },
	{ id: 'ul-s-ready',  label: 'Ready!' },
] as const;

type UsageLoadingStepId = typeof USAGE_LOADING_STEPS[number]['id'];

const USAGE_STAGE_MAP: Record<string, { pct: number; stepId: UsageLoadingStepId; subtitle: string }> = {
	start:                     { pct:  5, stepId: 'ul-s-start',  subtitle: 'Starting usage analysis…' },
	'curation:start':          { pct: 20, stepId: 'ul-s-tools',  subtitle: 'Collecting tools and skills…' },
	'curation:runtimeTools':   { pct: 32, stepId: 'ul-s-tools',  subtitle: 'Collected runtime tools' },
	'curation:mcpJson':        { pct: 44, stepId: 'ul-s-mcp',    subtitle: 'Scanning MCP config files…' },
	'curation:mcpSources':     { pct: 55, stepId: 'ul-s-mcp',    subtitle: 'Collected MCP servers' },
	'curation:skillsScanStart':{ pct: 63, stepId: 'ul-s-skills', subtitle: 'Scanning skill directories…' },
	'curation:skillsScanDone': { pct: 75, stepId: 'ul-s-skills', subtitle: 'Skill discovery complete' },
	'curation:analyzing':      { pct: 85, stepId: 'ul-s-crunch', subtitle: 'Analyzing tool usage patterns…' },
	'curation:done':           { pct: 96, stepId: 'ul-s-crunch', subtitle: 'Curation analysis complete' },
	ready:                     { pct:100, stepId: 'ul-s-ready',  subtitle: 'Usage analysis ready' },
	error:                     { pct:100, stepId: 'ul-s-ready',  subtitle: 'Analysis completed with errors' },
	'curation:error':          { pct: 85, stepId: 'ul-s-crunch', subtitle: 'Curation analysis skipped' },
};

export function renderUsageLoadingState(initialMessage = 'Loading usage analysis...'): void {
	const root = document.getElementById('root');
	if (!root) { return; }
	_ulLoadingActive = true;

	const stepsHtml = USAGE_LOADING_STEPS.map((s, i) => {
		const isFirst = i === 0;
		const cls = isFirst ? 'ul-step ul-active' : 'ul-step';
		const ico = isFirst ? '<span class="ul-spin">↻</span>' : '○';
		return `<div class="${cls}" id="${s.id}"><span class="ul-ico">${ico}</span><span class="ul-lbl">${escapeHtml(s.label)}</span><span class="ul-cnt" id="${s.id}-cnt"></span></div>`;
	}).join('');

	setHtml(root, `${USAGE_LOADING_CSS}
<div id="usage-loading-wrap">
  <div id="usage-loading-card">
    <div id="ul-header">
      <div>
        <div id="ul-badge">📊 Analyzing Usage Data</div>
        <div id="ul-title">${escapeHtml(initialMessage)}</div>
        <div id="ul-subtitle">Initializing…</div>
      </div>
      <div id="ul-right">
        <div id="ul-pct">–</div>
        <div style="display:flex;gap:6px;" id="ul-meta"></div>
      </div>
    </div>
    <div id="ul-track"><div id="ul-fill" class="ul-indeterminate"></div></div>
    <div id="ul-steps">${stepsHtml}</div>
  </div>
</div>`);
}

function _ulSetDone(id: string): void {
	const el = document.getElementById(id);
	if (!el) { return; }
	el.className = 'ul-step ul-done';
	const ico = el.querySelector('.ul-ico');
	if (ico) { setHtml(ico, '<span class="ul-pop">✓</span>'); }
}

function _ulSetActive(id: string): void {
	const el = document.getElementById(id);
	if (!el) { return; }
	el.className = 'ul-step ul-active';
	const ico = el.querySelector('.ul-ico');
	if (ico) { setHtml(ico, '<span class="ul-spin">↻</span>'); }
}

function _ulSetCnt(id: string, text: string): void {
	const el = document.getElementById(`${id}-cnt`);
	if (el) { el.textContent = text; }
}

let _ulLastStepIdx = 0;
// True while the loading card is the active view. Once real content is
// rendered (updateStats) this is cleared, so stray progress events from a
// background silent recompute never re-create the loading card over content.
let _ulLoadingActive = false;

/** Marks the loading card as no longer the active view (real content replaced it). */
export function markUsageLoadingInactive(): void { _ulLoadingActive = false; }

/** Restarts the step tracker so the next progress run begins at the first step. */
export function resetUsageLoadingSteps(): void { _ulLastStepIdx = 0; }

function _ulAdvanceSteps(targetIdx: number, pct: number): void {
	for (let i = _ulLastStepIdx; i < targetIdx; i++) { _ulSetDone(USAGE_LOADING_STEPS[i].id); }
	if (targetIdx > _ulLastStepIdx) { _ulLastStepIdx = targetIdx; }
	if (pct < 100) { _ulSetActive(USAGE_LOADING_STEPS[targetIdx].id); }
	else { _ulSetDone(USAGE_LOADING_STEPS[targetIdx].id); }
}

function _ulDetailCnt(details: Record<string, unknown>): string {
	if (typeof details.count === 'number') { return `${details.count}`; }
	if (typeof details.skills === 'number') { return `${details.skills} skills`; }
	if (typeof details.availableTools === 'number') { return `${details.availableTools} tools`; }
	return '';
}

// Ensures the loading card exists before applying a progress event. Returns
// false when the event should be ignored because content has already replaced
// the card (stray events from a background silent recompute), preventing the
// loading card from flashing back over the rendered analysis.
function _ulEnsureCard(onCardRecreated: () => void): boolean {
	const root = document.getElementById('root');
	if (!root) { return false; }
	if (root.querySelector('#usage-loading-card')) { return true; }
	if (!_ulLoadingActive) { return false; }
	onCardRecreated();
	renderUsageLoadingState('Building Usage Analysis');
	_ulLastStepIdx = 0;
	return true;
}

export function updateUsageLoadingProgress(message: any, onCardRecreated: () => void = () => undefined): void {
	if (!_ulEnsureCard(onCardRecreated)) { return; }
	const stage = typeof message?.stage === 'string' ? message.stage : '';
	const mapped = USAGE_STAGE_MAP[stage];
	if (!mapped) { return; }

	const pct = mapped.pct;
	const fill = document.getElementById('ul-fill');
	if (fill) { fill.classList.remove('ul-indeterminate'); fill.style.width = `${Math.max(pct, 3)}%`; }
	const pctEl = document.getElementById('ul-pct');
	if (pctEl) { pctEl.textContent = pct === 100 ? '100%' : `${pct}%`; }
	const subtitleEl = document.getElementById('ul-subtitle');
	if (subtitleEl) { subtitleEl.textContent = mapped.subtitle; }

	const targetIdx = USAGE_LOADING_STEPS.findIndex(s => s.id === mapped.stepId);
	if (targetIdx >= 0) { _ulAdvanceSteps(targetIdx, pct); }

	const details = message?.details;
	if (details && typeof details === 'object') {
		const cnt = _ulDetailCnt(details as Record<string, unknown>);
		if (cnt) { _ulSetCnt(mapped.stepId, `(${cnt})`); }
	}
}
