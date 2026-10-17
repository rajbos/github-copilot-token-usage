import type { AutonomyUsage } from './types';

export type AutonomyKind = keyof AutonomyUsage;

export function createEmptyAutonomyUsage(): AutonomyUsage {
	return { autonomous: 0, supervised: 0, plan: 0, other: 0 };
}

/**
 * Classify a raw mode string from a session log. Returns null for absent/unrecognised values so
 * callers don't count interactions on surfaces that never reported one.
 *
 * - Copilot CLI `agentMode` (user.message): autopilot | interactive | plan
 * - VS Code Copilot Chat `inputState.permissionLevel`: autopilot | default
 * - Claude Code `permissionMode`: auto | default | acceptEdits | plan | bypassPermissions | dontAsk
 */
export function classifyAutonomy(raw: unknown): AutonomyKind | null {
	if (typeof raw !== 'string') { return null; }
	switch (raw.toLowerCase()) {
		case 'autopilot':
		case 'auto':
			return 'autonomous';
		case 'interactive':
		case 'default':
		case 'acceptedits':
			return 'supervised';
		case 'plan':
			return 'plan';
		case 'bypasspermissions':
		case 'dontask':
			return 'other';
		default:
			return null;
	}
}

/** Count one interaction under the given raw mode, creating `analysis.autonomyUsage` lazily. */
export function recordAutonomy(analysis: { autonomyUsage?: AutonomyUsage }, raw: unknown): void {
	const kind = classifyAutonomy(raw);
	if (!kind) { return; }
	analysis.autonomyUsage ??= createEmptyAutonomyUsage();
	analysis.autonomyUsage[kind]++;
}

/** Add `from` into `period.autonomyUsage` (no-op when the session reported nothing). */
export function mergeAutonomyUsage(period: { autonomyUsage?: AutonomyUsage }, from: AutonomyUsage | undefined): void {
	if (!from) { return; }
	const dest = (period.autonomyUsage ??= createEmptyAutonomyUsage());
	dest.autonomous += from.autonomous;
	dest.supervised += from.supervised;
	dest.plan += from.plan;
	dest.other += from.other;
}
