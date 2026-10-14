export interface ToolFamily {
	/** Stable identifier used for override matching (e.g. "reading"). */
	id: string;
	/** Display name shown in the UI. */
	name: string;
	/** Built-in / baseline tool names that define the reference point. */
	builtIn: string[];
	/** Alternative / efficient-replacement tool names to compare against the built-ins. */
	alternatives: string[];
	/** Optional short description shown as a tooltip or subtitle. */
	description?: string;
}

/** Default tool family definitions. Tool names are matched against normalized names in outputTokensByTool. */
export const DEFAULT_TOOL_FAMILIES: ToolFamily[] = [
	{
		id: 'code-intelligence',
		name: 'Code Intelligence',
		builtIn: ['get_errors', 'hover', 'get_references', 'get_definition'],
		alternatives: ['lsp', 'diagnostics', 'symbol_lookup', 'search_workspace_symbols', 'list_code_usages'],
		description: 'Tools that query language-server or IDE intelligence.',
	},
	{
		id: 'reading',
		name: 'File Reading',
		builtIn: ['read', 'view', 'cat', 'Read', 'read_file', 'copilot_readFile'],
		alternatives: ['lean-ctx'],
		description: 'Tools that read file contents into context.',
	},
	{
		id: 'writing',
		name: 'File Writing',
		builtIn: ['edit', 'create', 'write', 'Edit', 'Write', 'edit_file', 'write_file', 'create_file'],
		alternatives: [
			'insert_edit_into_file',
			'replace_string_in_file',
			'str_replace_editor',
			'search_replace',
			'apply_patch',
			'multi_edit',
			'MultiEdit',
			'copilot_createFile',
			'copilot_editFile',
		],
		description: 'Tools that create or modify files. Alternatives use surgical patch/diff-style edits instead of rewriting whole files.',
	},
	{
		id: 'search',
		name: 'Search & Discovery',
		builtIn: ['search', 'grep', 'rg', 'glob', 'find', 'Grep', 'Glob', 'grep_search', 'file_search', 'list_dir', 'list_directory', 'ls'],
		alternatives: ['symdex', 'search_files', 'copilot_searchFiles', 'semantic_search', 'codebase_search'],
		description: 'Tools that search or list the codebase for files, directories, or text patterns.',
	},
	{
		id: 'shell',
		name: 'Shell / Terminal',
		builtIn: ['run_in_terminal', 'bash', 'shell', 'Bash', 'run_shell_command', 'run_command_in_terminal', 'send_to_terminal', 'run_build', 'windsurf_terminal'],
		alternatives: ['run_command', 'execute_command'],
		description: 'Tools that execute shell commands.',
	},
	{
		id: 'web',
		name: 'Web & Research',
		builtIn: ['web_fetch', 'webfetch', 'WebFetch', 'fetch_webpage'],
		alternatives: ['web_search', 'websearch', 'WebSearch', 'google_web_search'],
		description: 'Tools that fetch or search external web content.',
	},
];

/**
 * Merge user-provided family overrides with the defaults.
 * - User entries whose `id` matches a default replace that default entirely.
 * - User entries with no matching default are appended as new families.
 * - Family order: defaults first (with replacements in-place), then new user families.
 * - Tool-to-family assignment: first family that lists the tool wins (no duplicates).
 */
export function mergeToolFamilies(overrides: ToolFamily[]): ToolFamily[] {
	const result: ToolFamily[] = DEFAULT_TOOL_FAMILIES.map(def => {
		const override = overrides.find(o => o.id === def.id);
		return override ?? def;
	});
	for (const override of overrides) {
		if (!DEFAULT_TOOL_FAMILIES.some(def => def.id === override.id)) {
			result.push(override);
		}
	}
	return result;
}
