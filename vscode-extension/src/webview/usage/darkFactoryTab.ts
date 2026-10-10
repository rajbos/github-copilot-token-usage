import { setHtml } from '../shared/domUtils';
import { localize } from '../shared/localization';
import { buildDarkFactoryChatPrompt, buildDarkFactorySectionHtml } from '../maturity/darkFactorySection';
import type { DarkFactoryReport } from '../../../../src/types';

type ReadinessMessage = { command: string; requestId?: unknown; report?: unknown; refreshing?: unknown };
type OutgoingMessage =
	| { command: 'loadReadiness'; requestId: number; force?: boolean }
	| { command: 'draftCopilotChatWithPrompt'; prompt: string };

export class DarkFactoryTab {
	private report: DarkFactoryReport | undefined;
	private status: 'idle' | 'loading' | 'loaded' | 'error' = 'idle';
	private requestId = 0;
	private available = false;
	/** A cached report is on screen while a fresh scan runs in the background. */
	private refreshing = false;

	constructor(
		private readonly postMessage: (message: OutgoingMessage) => void,
		private readonly trace: (stage: string, details: Record<string, unknown>) => void,
	) {}

	setAvailable(available: boolean): void {
		this.available = available;
	}

	button(activeTab: string): string {
		if (!this.available) { return ''; }
		return `<button class="tab-button ${activeTab === 'readiness' ? 'active' : ''}" data-tab="readiness"><span class="codicon codicon-shield"></span> ${localize('nav.btnReadiness')}</button>`;
	}

	panel(activeTab: string): string {
		if (!this.available) { return ''; }
		return `<div id="tab-panel-readiness" class="tab-panel"${activeTab !== 'readiness' ? ' style="display:none"' : ''}>
			<div class="section">
				<div class="section-title"><span class="codicon codicon-shield"></span><span>${localize('nav.btnReadiness')}</span></div>
				<button class="button secondary" id="btn-refresh-readiness">${localize('nav.btnRefresh')}</button>
				<div id="readiness-content"></div>
			</div>
		</div>`;
	}

	attach(): void {
		document.getElementById('btn-refresh-readiness')?.addEventListener('click', () => this.requestScan(true));
		// Delegated: the report re-renders on every scan, the container does not.
		const content = document.getElementById('readiness-content');
		if (content && !content.dataset.dfBound) {
			content.dataset.dfBound = 'true';
			content.addEventListener('click', event => this.handleContentClick(event));
		}
		this.render();
	}

	/** Opens a new Copilot Chat pre-filled with the items picked in one repository card. */
	private handleContentClick(event: Event): void {
		const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('.df-chat-btn');
		if (!button || !this.report) { return; }
		const repoIndex = Number(button.dataset.dfRepo);
		const repo = this.report.repos[repoIndex];
		const card = button.closest('.df-repo-card');
		if (!repo || !card) { return; }
		const picked = (kind: string) => Array.from(card.querySelectorAll<HTMLInputElement>(`.df-pick[data-df-kind="${kind}"]:checked`))
			.map(input => input.dataset.dfId ?? '');
		const prompt = buildDarkFactoryChatPrompt(repo, picked('control'), picked('finding'));
		if (!prompt) {
			button.textContent = localize('readiness.action.selectFirst');
			return;
		}
		button.textContent = localize('readiness.action.draft');
		this.postMessage({ command: 'draftCopilotChatWithPrompt', prompt });
	}

	render(): void {
		const content = document.getElementById('readiness-content');
		if (!content) { return; }
		const html = this.status === 'loaded' && this.report
			? (this.refreshing ? `<div class="df-empty" role="status">${localize('readiness.refreshing')}</div>` : '') + buildDarkFactorySectionHtml(this.report)
			: this.status === 'error'
				? `<div class="df-error" role="alert">${localize('readiness.scanFailed')}</div>`
				: `<div class="df-empty" role="status">${localize('readiness.loading')}</div>`;
		setHtml(content, html);
	}

	startIfNeeded(): void {
		if (this.available && this.status === 'idle') { this.requestScan(); }
	}

	/** `force` is the Refresh button: re-scan even when the cached report is recent. */
	requestScan(force = false): void {
		if (!this.available || this.status === 'loading' || this.refreshing) { return; }
		const hasReport = this.status === 'loaded' && !!this.report;
		// Keep showing what we have while a forced refresh runs.
		if (hasReport) { this.refreshing = true; } else { this.status = 'loading'; }
		this.render();
		this.postMessage({ command: 'loadReadiness', requestId: ++this.requestId, ...(force ? { force: true } : {}) });
	}

	invalidate(): void {
		this.status = 'idle';
		this.refreshing = false;
		// The host replays its cached report on the next open, so nothing is lost by dropping this one.
		this.report = undefined;
		this.requestId++;
	}

	handleMessage(message: ReadinessMessage): boolean {
		if (message.command !== 'readinessLoaded' && message.command !== 'readinessScanFailed') { return false; }
		if (message.requestId !== this.requestId) { return true; }
		if (message.command === 'readinessScanFailed') {
			// A failed background refresh must not discard a report we can still show.
			this.refreshing = false;
			if (!this.report) { this.status = 'error'; }
		} else if (!message.report || typeof message.report !== 'object' || !Array.isArray((message.report as DarkFactoryReport).repos)) {
			this.trace('readinessLoaded.invalidReport', { hasReport: !!message.report });
			this.refreshing = false;
			if (!this.report) { this.status = 'error'; }
		} else {
			this.report = message.report as DarkFactoryReport;
			this.status = 'loaded';
			this.refreshing = message.refreshing === true;
		}
		this.render();
		return true;
	}
}
