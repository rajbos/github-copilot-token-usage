/**
 * Shared utilities for working with context references across webviews
 */

export type ContextReferenceUsage = {
	file: number;
	selection: number;
	implicitSelection: number;
	symbol: number;
	codebase: number;
	workspace: number;
	terminal: number;
	vscode: number;
	terminalLastCommand: number;
	terminalSelection: number;
	clipboard: number;
	changes: number;
	outputPanel: number;
	problemsPanel: number;
	byKind: { [kind: string]: number };
	copilotInstructions: number;
	agentsMd: number;
	byPath: { [path: string]: number };
};

/**
 * Calculate the total number of context references.
 * This is the single source of truth for what constitutes a context reference.
 */
export function getTotalContextRefs(refs: ContextReferenceUsage): number {
	return refs.file + refs.selection + refs.implicitSelection + refs.symbol + refs.codebase +
		refs.workspace + refs.terminal + refs.vscode + refs.copilotInstructions + refs.agentsMd +
		(refs.terminalLastCommand || 0) + (refs.terminalSelection || 0) + (refs.clipboard || 0) +
		(refs.changes || 0) + (refs.outputPanel || 0) + (refs.problemsPanel || 0);
}

/**
 * Calculate the count of implicit (auto-attached) context references.
 * Implicit refs are not user-initiated: copilotInstructions, agentsMd, implicitSelection
 */
export function getImplicitContextRefs(refs: ContextReferenceUsage): number {
	return refs.copilotInstructions + refs.agentsMd + refs.implicitSelection;
}

/**
 * Calculate the count of explicit (user-initiated) context references.
 * Explicit refs are user-initiated: #file, #selection, #symbol, #codebase, @workspace, @terminal, @vscode, etc.
 */
export function getExplicitContextRefs(refs: ContextReferenceUsage): number {
	return refs.file + refs.selection + refs.symbol + refs.codebase +
		refs.workspace + refs.terminal + refs.vscode +
		(refs.terminalLastCommand || 0) + (refs.terminalSelection || 0) + (refs.clipboard || 0) +
		(refs.changes || 0) + (refs.outputPanel || 0) + (refs.problemsPanel || 0);
}

/**
 * Generate a summary string of context references.
 * @param refs - The context reference usage counts
 * @param abbreviated - If true, use short labels (e.g., '#sel' instead of '#selection')
 */
export function getContextRefsSummary(refs: ContextReferenceUsage, abbreviated = false): string {
	const parts: string[] = [];
	
	if (abbreviated) {
		// Abbreviated labels for compact display (used in diagnostics)
		if (refs.file > 0) { parts.push(`#file: ${refs.file}`); }
		if (refs.selection > 0) { parts.push(`#sel: ${refs.selection}`); }
		if (refs.implicitSelection > 0) { parts.push(`impl: ${refs.implicitSelection}`); }
		if (refs.symbol > 0) { parts.push(`#sym: ${refs.symbol}`); }
		if (refs.codebase > 0) { parts.push(`#cb: ${refs.codebase}`); }
		if (refs.workspace > 0) { parts.push(`@ws: ${refs.workspace}`); }
		if (refs.terminal > 0) { parts.push(`@term: ${refs.terminal}`); }
		if (refs.vscode > 0) { parts.push(`@vsc: ${refs.vscode}`); }
		if ((refs.terminalLastCommand || 0) > 0) { parts.push(`#termLC: ${refs.terminalLastCommand}`); }
		if ((refs.terminalSelection || 0) > 0) { parts.push(`#termSel: ${refs.terminalSelection}`); }
		if ((refs.clipboard || 0) > 0) { parts.push(`#clip: ${refs.clipboard}`); }
		if ((refs.changes || 0) > 0) { parts.push(`#chg: ${refs.changes}`); }
		if ((refs.outputPanel || 0) > 0) { parts.push(`#out: ${refs.outputPanel}`); }
		if ((refs.problemsPanel || 0) > 0) { parts.push(`#prob: ${refs.problemsPanel}`); }
		if (refs.copilotInstructions > 0) { parts.push(`📋 inst: ${refs.copilotInstructions}`); }
		if (refs.agentsMd > 0) { parts.push(`🤖 ag: ${refs.agentsMd}`); }
	} else {
		// Full labels for detailed display (used in logviewer)
		if (refs.file > 0) { parts.push(`#file: ${refs.file}`); }
		if (refs.selection > 0) { parts.push(`#selection: ${refs.selection}`); }
		if (refs.implicitSelection > 0) { parts.push(`implicit: ${refs.implicitSelection}`); }
		if (refs.symbol > 0) { parts.push(`#symbol: ${refs.symbol}`); }
		if (refs.codebase > 0) { parts.push(`#codebase: ${refs.codebase}`); }
		if (refs.workspace > 0) { parts.push(`@workspace: ${refs.workspace}`); }
		if (refs.terminal > 0) { parts.push(`@terminal: ${refs.terminal}`); }
		if (refs.vscode > 0) { parts.push(`@vscode: ${refs.vscode}`); }
		if ((refs.terminalLastCommand || 0) > 0) { parts.push(`#terminalLastCommand: ${refs.terminalLastCommand}`); }
		if ((refs.terminalSelection || 0) > 0) { parts.push(`#terminalSelection: ${refs.terminalSelection}`); }
		if ((refs.clipboard || 0) > 0) { parts.push(`#clipboard: ${refs.clipboard}`); }
		if ((refs.changes || 0) > 0) { parts.push(`#changes: ${refs.changes}`); }
		if ((refs.outputPanel || 0) > 0) { parts.push(`#outputPanel: ${refs.outputPanel}`); }
		if ((refs.problemsPanel || 0) > 0) { parts.push(`#problemsPanel: ${refs.problemsPanel}`); }
		if (refs.copilotInstructions > 0) { parts.push(`📋 instructions: ${refs.copilotInstructions}`); }
		if (refs.agentsMd > 0) { parts.push(`🤖 agents: ${refs.agentsMd}`); }
	}
	
	return parts.length > 0 ? parts.join(', ') : 'None';
}
