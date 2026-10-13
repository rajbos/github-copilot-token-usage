/**
 * Shared "Building Activity Index" loading screen — CSS, markup, and the
 * progress-driven animation script.
 *
 * Used by both the VS Code extension host (extension.ts getLoadingHtml) and
 * the Windows desktop app (desktop/src/main.ts buildLoadingHtml) so the two
 * surfaces show the exact same loading experience. Deliberately vscode-free:
 * plain string builders only.
 *
 * The script listens for `message` events on `window` with payloads:
 *   { command: 'loadingStep', step: 'discovering' | 'parsing' | 'computing',
 *     total?, editors?, percentage?, label? }
 *     (`percentage`/`label` apply to the 'computing' step: a caller that can break its
 *      compute phase into sub-steps drives the bar through them instead of parking it
 *      at the default 96% for the whole phase.)
 *   { command: 'loadingProgress', completed, total, percentage, editors? }
 * In VS Code these arrive via webview.postMessage; in the desktop app the
 * preload bridges ipcRenderer 'loading-message' events to window.postMessage.
 */

export function getLoadingHtmlCssBase(): string {
	return `:root {
    --bg-primary: var(--vscode-editor-background, #1e1e2e);
    --bg-secondary: var(--vscode-sideBar-background, #181825);
    --bg-card: var(--vscode-editorWidget-background, #24273a);
    --text-primary: var(--vscode-editor-foreground, #cdd6f4);
    --text-muted: var(--vscode-descriptionForeground, #9399b2);
    --accent: var(--vscode-textLink-foreground, #89b4fa);
    --success: var(--vscode-terminal-ansiGreen, #a6e3a1);
    --border: var(--vscode-panel-border, #313244);
    --badge-bg: var(--vscode-badge-background, #313244);
    --badge-fg: var(--vscode-badge-foreground, #cdd6f4);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    background: var(--bg-primary); color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px;
}
.card { width: 100%; max-width: 680px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 16px; padding: 24px 28px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
.header-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; gap: 16px; }
.badge-label { font-size: 11px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: var(--accent); margin-bottom: 4px; }
.title { font-size: 22px; font-weight: 700; color: var(--text-primary); margin-bottom: 4px; }
.subtitle { font-size: 12px; color: var(--text-muted); margin-bottom: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
.header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
.pct-display { font-size: 32px; font-weight: 800; color: var(--text-primary); line-height: 1; min-width: 70px; text-align: right; font-variant-numeric: tabular-nums; }
.meta-badges { display: flex; gap: 6px; }
.meta-badge { font-size: 11px; padding: 3px 10px; border: 1px solid var(--border); border-radius: 20px; color: var(--text-muted); background: var(--bg-card); white-space: nowrap; }
.progress-wrap { margin: 16px 0; }
.progress-track { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--accent), var(--success)); transition: width 0.5s ease; width: 2%; position: relative; }
.progress-fill.indeterminate { width: 25%; animation: slide-shimmer 1.8s ease-in-out infinite; background: linear-gradient(90deg, transparent, var(--accent), var(--success), transparent); }
@keyframes slide-shimmer { 0% { margin-left: -30%; } 100% { margin-left: 110%; } }
.stats-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 20px; font-size: 12px; color: var(--text-primary); }
.chip .chip-value { font-weight: 700; }`;
}

export function getLoadingHtmlCssSteps(): string {
	return `.steps-box { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
.step { display: flex; align-items: center; gap: 10px; padding: 5px 0; color: var(--text-muted); font-size: 13px; transition: color 0.25s; }
.step.step-done   { color: var(--success); }
.step.step-active { color: var(--accent); font-weight: 600; }
.step-ico { width: 18px; text-align: center; flex-shrink: 0; font-style: normal; }
.spin-ico { display: inline-block; animation: spin 0.75s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.step-lbl { flex: 1; }
.step-cnt { font-size: 11px; opacity: 0.75; font-variant-numeric: tabular-nums; }
@keyframes pop-in { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.3); } 100% { transform: scale(1); opacity: 1; } }
.pop { animation: pop-in 0.35s ease both; }`;
}

export function getLoadingHtmlBody(nonce: string, iconUri?: string, startedAtMs: number = Date.now()): string {
	const badgeIcon = iconUri
		? `<img src="${iconUri}" alt="" width="20" height="20" style="vertical-align:middle;margin-right:6px;border-radius:3px;" />`
		: '🤖 ';
	return `<body>
<div class="card">
    <div class="header-row">
        <div>
            <div class="badge-label">${badgeIcon}Analyzing Your AI Activity</div>
            <div class="title">Building Activity Index</div>
            <div class="subtitle" id="subtitle">Discovering session files...</div>
        </div>
        <div class="header-right">
            <div class="pct-display" id="pct">–</div>
            <div class="meta-badges">
                <div class="meta-badge" id="badge-files">– files</div>
                <div class="meta-badge" id="badge-elapsed">0s</div>
            </div>
        </div>
    </div>
    <div class="progress-wrap"><div class="progress-track"><div class="progress-fill indeterminate" id="prog-fill"></div></div></div>
    <div class="stats-chips" id="chips" style="display:none">
        <div class="chip">📂 <span class="chip-value" id="chip-total">–</span> session files</div>
        <div class="chip">✅ <span class="chip-value" id="chip-done">–</span> processed</div>
    </div>
    <div id="editors-row" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;"></div>
    <div class="steps-box">
        <div class="step step-active" id="s-discover"><i class="step-ico"><span class="spin-ico">↻</span></i><span class="step-lbl">Discovering session files</span><span class="step-cnt" id="sc-discover"></span></div>

        <div class="step" id="s-parse"><i class="step-ico">○</i><span class="step-lbl">Parsing session logs</span><span class="step-cnt" id="sc-parse"></span></div>
        <div class="step" id="s-compute"><i class="step-ico">○</i><span class="step-lbl">Computing statistics</span><span class="step-cnt"></span></div>
        <div class="step" id="s-ready"><i class="step-ico">○</i><span class="step-lbl">Ready!</span><span class="step-cnt"></span></div>
    </div>
</div>
<script nonce="${nonce}">
${getLoadingHtmlScript(startedAtMs)}
</script>
</body>`;
}

/**
 * The loading screen's inline script.
 *
 * On the 'computing' step the host may send a `percentage` and `label` per compute
 * sub-step so the bar keeps moving through a long aggregation phase; a host that
 * computes in one opaque block sends neither and gets the historical fixed 96%.
 *
 * `barPct` is the value behind the bar, fed by both phases: parsing progress is scaled
 * into the lower 85% and compute sub-steps occupy the rest. Parsing always ends on a
 * 100% tick, so without that split the first compute step would drop the bar (to 88%,
 * or to 96% for a host that sends no sub-steps at all).
 *
 * The clamp applies only once the compute phase has begun, not within parsing itself.
 * A parsing percentage can legitimately fall — `_preloadSessionFiles` reports against a
 * discovery total that grows as adapter batches arrive, so an early batch can read 1/1
 * and a later tick 2/400 — and clamping that would freeze the bar at the high-water mark
 * for the rest of the parse. After a compute sub-step, a parsing tick is stale (a
 * concurrent background refresh shares this channel) and must not drag the bar back.
 *
 * Kept as one function (not split further) deliberately: scripts/check-hardcoded-strings.mjs
 * scans this file's own string/template literals for embedded HTML tag structure, and splitting
 * this script across multiple functions/literals broke its ability to recognize the content as
 * a single opaque script body — see this PR's own history for the CI failure that caused.
 */
export function getLoadingHtmlScript(startedAtMs: number = Date.now()): string {
	return `(function () {
    var t0 = ${Math.floor(startedAtMs)};
    var EDITORS = [];
    var editorsSeen = 0, barPct = 0, computing = false;
    function updateElapsed() {
        var s = Math.floor((Date.now() - t0) / 1000);
        var el = document.getElementById('badge-elapsed');
        if (!el) return;
        if (s < 60) { el.textContent = s + 's'; } else { el.textContent = Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
    }
    updateElapsed();
    setInterval(updateElapsed, 1000);
    function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function setDone(id) {
        var el = document.getElementById(id); if (!el) return;
        el.classList.remove('step-active'); el.classList.add('step-done');
        var ico = el.querySelector('.step-ico'); if (ico) { ico.className = 'step-ico'; ico.innerHTML = '<span class="pop">✓</span>'; }
    }
    function setActive(id) {
        var el = document.getElementById(id); if (!el) return;
        el.classList.remove('step-done'); el.classList.add('step-active');
        var ico = el.querySelector('.step-ico'); if (ico) { ico.className = 'step-ico'; ico.innerHTML = '<span class="spin-ico">↻</span>'; }
    }
    function setPending(id) {
        var el = document.getElementById(id); if (!el) return;
        el.classList.remove('step-active'); el.classList.remove('step-done');
        var ico = el.querySelector('.step-ico'); if (ico) { ico.className = 'step-ico'; ico.innerHTML = '○'; }
    }
    // Advance the checklist into the parsing phase. Idempotent: the step transition runs
    // once even if it is triggered by a loadingProgress message because the one-time
    // loadingStep 'parsing' was posted before this webview's listener was attached.
    var parsingShown = false;
    function enterParsing(total) {
        if (!parsingShown) {
            parsingShown = true;
            setDone('s-discover'); setActive('s-parse');
            var chips = document.getElementById('chips'); if (chips) chips.style.display = 'flex';
        }
        if (total) { var sc = document.getElementById('sc-discover'); if (sc) sc.textContent = '(' + total + ' found)'; }
    }
    window.addEventListener('message', function (ev) {
        var m = ev.data; if (!m) return;
        if (m.command === 'loadingStep') {
            if (m.step === 'discovering') {
                // A panel a superseded run left registered for a replacement (see isRefreshSuperseded()
                // callers in extension.ts) keeps this exact script instance alive instead of getting a
                // fresh getLoadingHtml() paint, so the replacement's own first 'discovering' message is
                // the only signal this script gets that a new refresh has actually started. Without
                // resetting here, the checklist stays stuck showing 's-parse'/'s-compute' as already
                // done, computing/barPct stay clamped from the old run's compute phase (so the new
                // run's own early parsing ticks render as if compute were already well underway), and
                // stale editor pills from the old run linger in the row.
                parsingShown = false; computing = false; barPct = 0; EDITORS = []; editorsSeen = 0;
                setActive('s-discover'); setPending('s-parse'); setPending('s-compute');
                var chips0 = document.getElementById('chips'); if (chips0) chips0.style.display = 'none';
                var fill0 = document.getElementById('prog-fill'); if (fill0) { fill0.classList.add('indeterminate'); fill0.style.width = ''; }
                var pct0 = document.getElementById('pct'); if (pct0) pct0.textContent = '–';
                var sub0 = document.getElementById('subtitle'); if (sub0) sub0.textContent = 'Discovering session files...';
                var bf0 = document.getElementById('badge-files'); if (bf0) bf0.textContent = '– files';
                var row0 = document.getElementById('editors-row'); if (row0) row0.innerHTML = '';
                var scd0 = document.getElementById('sc-discover'); if (scd0) scd0.textContent = '';
                var scp0 = document.getElementById('sc-parse'); if (scp0) scp0.textContent = '';
            } else if (m.step === 'parsing') {
                var total = m.total || 0;
                if (m.editors !== undefined) { EDITORS = m.editors; editorsSeen = 0; }
                enterParsing(total);
                var sub = document.getElementById('subtitle'); if (sub) sub.textContent = 'Parsing ' + total + ' session files...';
                var bf = document.getElementById('badge-files'); if (bf) bf.textContent = total + ' files';
                var ct = document.getElementById('chip-total'); if (ct) ct.textContent = total.toLocaleString();
            } else if (m.step === 'computing') {
                enterParsing(0);
                setDone('s-parse'); setActive('s-compute'); computing = true; barPct = Math.max(barPct, typeof m.percentage === 'number' ? m.percentage : 96);
                var fill = document.getElementById('prog-fill'); if (fill) { fill.classList.remove('indeterminate'); fill.style.width = barPct + '%'; }
                var pct = document.getElementById('pct'); if (pct) pct.textContent = barPct + '%';
                var sub2 = document.getElementById('subtitle'); if (sub2) sub2.textContent = m.label || 'Computing statistics...';
            }
        } else if (m.command === 'loadingProgress') {
            // Receiving progress means parsing is underway — reconcile the checklist in case
            // the loadingStep 'parsing' transition was missed during webview startup.
            enterParsing(m.total);
            // Editors are included in every progress tick so pills appear even when the
            // one-time loadingStep 'parsing' message was dropped before the listener attached.
            if (m.editors && m.editors.length > EDITORS.length) { EDITORS = m.editors; }
            var pct2 = document.getElementById('pct'); var scaled = Math.round(m.percentage * 0.85); barPct = computing ? Math.max(barPct, scaled) : scaled; if (pct2) pct2.textContent = barPct + '%';
            var fill2 = document.getElementById('prog-fill'); if (fill2) { fill2.classList.remove('indeterminate'); fill2.style.width = (barPct < 3 ? 3 : barPct) + '%'; }
            var cd = document.getElementById('chip-done'); if (cd) cd.textContent = m.completed.toLocaleString();
            // Backfill the total chip too: when the one-time loadingStep 'parsing' message
            // was dropped before this listener attached, it would otherwise stay at '–'.
            var ct2 = document.getElementById('chip-total'); if (ct2 && m.total) ct2.textContent = m.total.toLocaleString();
            var bf2 = document.getElementById('badge-files'); if (bf2) bf2.textContent = m.completed + '\\u202f/\\u202f' + m.total + ' files';
            var sc2 = document.getElementById('sc-parse'); if (sc2) sc2.textContent = '(' + m.completed + '/' + m.total + ')';
            var sub3 = document.getElementById('subtitle'); if (sub3) sub3.textContent = 'Parsing session ' + m.completed + '\\u202f/\\u202f' + m.total + '\\u2026';
            var expectedPills = Math.min(EDITORS.length, Math.floor((m.completed / Math.max(1, m.total)) * EDITORS.length));
            while (editorsSeen < expectedPills) {
                var editor = EDITORS[editorsSeen]; editorsSeen++;
                var row = document.getElementById('editors-row');
                if (row) { var pill = document.createElement('div'); pill.className = 'chip'; pill.style.animation = 'pop-in 0.35s ease both'; pill.innerHTML = '<span>' + editor.icon + '</span>\\u00a0<span class="chip-value">' + esc(editor.name) + '</span>'; row.appendChild(pill); }
            }
        }
    });
}());`;
}
