/**
 * Event-loop lag monitor for the extension host.
 *
 * A webview click is a `postMessage` that can only be delivered between event-loop
 * ticks, so any synchronous stretch longer than a few hundred milliseconds shows up
 * to the user as a frozen panel. This samples tick delay with Node's built-in
 * histogram (cheap, runs off the JS thread) and reports stalls, so a regression is
 * visible in the log the moment it appears instead of in a user complaint.
 */
import { monitorEventLoopDelay } from 'perf_hooks';

/** One report window: how bad the loop was while it was being observed. */
export interface EventLoopLagReport {
	/** Worst single tick delay in the window, in milliseconds. */
	maxMs: number;
	/** 99th-percentile tick delay in the window, in milliseconds. */
	p99Ms: number;
	/** Length of the window the numbers cover, in milliseconds. */
	windowMs: number;
}

export interface EventLoopMonitorOptions {
	/** Histogram sampling resolution. Lower = finer but marginally more overhead. */
	resolutionMs?: number;
	/** How often a window is closed and inspected. */
	reportIntervalMs?: number;
	/** A window whose worst tick reached this is reported as a stall. */
	stallThresholdMs?: number;
	/** Called once per stalled window. */
	onStall: (report: EventLoopLagReport) => void;
}

const DEFAULT_RESOLUTION_MS = 20;
const DEFAULT_REPORT_INTERVAL_MS = 2_000;
/** Above ~200ms a click feels broken; above ~1s it feels frozen. */
const DEFAULT_STALL_THRESHOLD_MS = 250;
const NS_PER_MS = 1e6;

export interface EventLoopMonitor {
	/** Most recent window that crossed the threshold, if any (for diagnostics). */
	readonly lastStall: (EventLoopLagReport & { at: number }) | undefined;
	/** Worst tick delay seen since `start()`, in milliseconds. */
	readonly worstMs: number;
	dispose(): void;
}

/**
 * Starts sampling. The returned handle's timers are `unref`'d so the monitor can never
 * keep a process alive, and `dispose()` is idempotent.
 */
export function startEventLoopMonitor(options: EventLoopMonitorOptions): EventLoopMonitor {
	const resolutionMs = options.resolutionMs ?? DEFAULT_RESOLUTION_MS;
	const reportIntervalMs = options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS;
	const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;

	const histogram: ReturnType<typeof monitorEventLoopDelay> = monitorEventLoopDelay({ resolution: resolutionMs });
	histogram.enable();

	let lastStall: (EventLoopLagReport & { at: number }) | undefined;
	let worstMs = 0;
	let windowStartedAt = Date.now();
	let disposed = false;

	const timer = setInterval(() => {
		const now = Date.now();
		const windowMs = now - windowStartedAt;
		windowStartedAt = now;
		// The histogram records the whole timer interval in nanoseconds, so a healthy loop reads about
		// `resolutionMs`; subtract that baseline to report how late the loop actually was.
		const maxMs = Math.max(0, histogram.max / NS_PER_MS - resolutionMs);
		const p99Ms = Math.max(0, histogram.percentile(99) / NS_PER_MS - resolutionMs);
		histogram.reset();
		if (maxMs > worstMs) { worstMs = maxMs; }
		if (maxMs >= stallThresholdMs) {
			const report = { maxMs: Math.round(maxMs), p99Ms: Math.round(p99Ms), windowMs };
			lastStall = { ...report, at: now };
			try { options.onStall(report); } catch { /* a logging failure must never break the monitor */ }
		}
	}, reportIntervalMs);
	timer.unref?.();

	return {
		get lastStall() { return lastStall; },
		get worstMs() { return worstMs; },
		dispose() {
			if (disposed) { return; }
			disposed = true;
			clearInterval(timer);
			histogram.disable();
		},
	};
}
