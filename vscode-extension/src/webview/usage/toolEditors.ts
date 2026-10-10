/**
 * Per-tool editor attribution for the unknown-tools banner and the pre-filled
 * "Report Unknown Tools" issue: which editor(s) each tool was seen in.
 */
export type ToolCallsByEditor = { [tool: string]: { [editor: string]: number } };

/**
 * Keep only `{ tool: { editor: number } }` entries with finite positive counts.
 * Both levels are built via Maps + `Object.fromEntries` so keys such as `__proto__` or
 * `constructor` become plain own data properties and never touch shared prototypes.
 */
export function sanitizeToolCallsByEditor(raw: unknown): ToolCallsByEditor | undefined {
	if (!raw || typeof raw !== 'object') { return undefined; }
	const tools = new Map<string, { [editor: string]: number }>();
	for (const [tool, byEditor] of Object.entries(raw as Record<string, unknown>)) {
		if (!byEditor || typeof byEditor !== 'object') { continue; }
		const editors = Object.entries(byEditor as Record<string, unknown>)
			.filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0);
		if (editors.length > 0) { tools.set(tool, Object.fromEntries(editors)); }
	}
	return Object.fromEntries(tools);
}

/** Editors a tool was seen in, most-used first, e.g. "Claude Code (CLI), VS Code". Empty when unknown. */
export function formatToolEditors(tool: string, toolCallsByEditor?: ToolCallsByEditor): string {
	if (!toolCallsByEditor || !Object.prototype.hasOwnProperty.call(toolCallsByEditor, tool)) { return ''; }
	const byEditor = toolCallsByEditor[tool];
	return Object.entries(byEditor).sort((a, b) => b[1] - a[1]).map(([editor]) => editor).join(', ');
}

/**
 * Host-side snapshot of the accumulator (tool -> editor -> count) as plain own-property
 * objects, so a tool named `__proto__` survives JSON serialization instead of being
 * swallowed by the prototype setter.
 */
export function toolCallsByEditorToRecord(accum: ReadonlyMap<string, ReadonlyMap<string, number>>): ToolCallsByEditor {
	return Object.fromEntries([...accum].map(([tool, byEditor]) => [tool, Object.fromEntries(byEditor)]));
}
