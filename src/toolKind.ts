/**
 * Classify an invoked tool name into a coarse kind, independent of which editor
 * produced it. Used to colour the cost-vs-speed map and, later, to bucket the
 * workflow-pathway Sankey.
 *
 * The individual signals already existed in separate places (MCP prefixes in
 * workspaceHelpers, delegation names in taskClassification, the skill wrapper
 * tools in the Claude Code and Copilot CLI parsers); this is the single place
 * that combines them.
 */
import { isMcpTool } from './utils/toolUtils';
import { DELEGATION_TOOL_PATTERN } from './taskClassification';

export type ToolKind = 'builtin' | 'mcp' | 'subagent' | 'skill';

export const TOOL_KINDS: readonly ToolKind[] = ['builtin', 'mcp', 'subagent', 'skill'];

/** Wrapper tools that invoke a skill: Claude Code's `Skill`, Copilot CLI's `skill`, and `__slash__` slash-command markers. */
const SKILL_TOOL_PATTERN = /^(skill|__slash__.*)$/i;

/** Copilot CLI names its MCP tools `<server>-<tool>` without an `mcp` prefix; the GitHub server is the common case. */
const COPILOT_CLI_MCP_PATTERN = /^[a-z0-9_-]+-mcp-server-/i;

export function classifyToolKind(toolName: string): ToolKind {
	if (isMcpTool(toolName) || COPILOT_CLI_MCP_PATTERN.test(toolName)) { return 'mcp'; }
	if (SKILL_TOOL_PATTERN.test(toolName)) { return 'skill'; }
	if (DELEGATION_TOOL_PATTERN.test(toolName)) { return 'subagent'; }
	return 'builtin';
}
