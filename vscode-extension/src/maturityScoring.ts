/**
 * Maturity/fluency scoring functions.
 * Computes AI Fluency Score and related metrics.
 */
import type {
	DetailedStats,
	UsageAnalysisStats,
	WorkspaceCustomizationMatrix,
	UsageAnalysisPeriod,
} from './types';
import automaticToolIds from './automaticTools.json';

/** Set of tool IDs that Copilot uses autonomously (reading files, searching, etc.).
 *  These are excluded from fluency scoring since the user doesn't configure them. */
const AUTOMATIC_TOOL_SET = new Set<string>((automaticToolIds as string[]).map(id => id.toLowerCase()));

/** Format a number with thousand separators for display. */
function fmt(n: number): string {
	return n.toLocaleString('en-US');
}

type CategoryScore = { stage: number; evidence: string[]; tips: string[] };

function _scorePromptEngineering(p: UsageAnalysisPeriod): CategoryScore {
	const evidence: string[] = [];
	const tips: string[] = [];
	let stage = 1;

	const totalInteractions = p.modeUsage.ask + p.modeUsage.edit + p.modeUsage.agent + p.modeUsage.cli;
	if (totalInteractions > 0) { evidence.push(`${fmt(totalInteractions)} total interactions`); }
	if (p.modeUsage.ask > 0) { evidence.push(`${fmt(p.modeUsage.ask)} ask-mode conversations`); }
	if (p.modeUsage.agent > 0) { evidence.push(`${fmt(p.modeUsage.agent)} agent-mode interactions`); }
	if (p.modeUsage.cli > 0) { evidence.push(`${fmt(p.modeUsage.cli)} CLI interactions`); }

	if (p.conversationPatterns) {
		const multiTurnRate = p.sessions > 0
			? Math.round((p.conversationPatterns.multiTurnSessions / p.sessions) * 100)
			: 0;
		if (p.conversationPatterns.multiTurnSessions > 0) {
			evidence.push(`${fmt(p.conversationPatterns.multiTurnSessions)} multi-turn sessions (${multiTurnRate}%)`);
		}
		if (p.conversationPatterns.avgTurnsPerSession >= 3) {
			evidence.push(`Avg ${p.conversationPatterns.avgTurnsPerSession.toFixed(1)} exchanges per session`);
			stage = Math.max(stage, 2) as 1 | 2 | 3 | 4;
		}
		if (p.conversationPatterns.avgTurnsPerSession >= 5) {
			stage = Math.max(stage, 3) as 1 | 2 | 3 | 4;
		}
	}

	if (totalInteractions >= 5) { stage = 2; }

	const slashCommands = ['explain', 'fix', 'tests', 'doc', 'generate', 'optimize', 'new', 'newNotebook', 'search', 'fixTestFailure', 'setupTests'];
	const claudeSlashCommands = ['review', 'bug', 'think', 'compact', 'pr_comments'];
	const usedSlashCommands = [
		...slashCommands.filter(cmd => (p.toolCalls.byTool[cmd] || 0) > 0),
		...claudeSlashCommands.filter(cmd => (p.toolCalls.byTool[`__slash__${cmd}`] || 0) > 0),
	];
	if (usedSlashCommands.length > 0) { evidence.push(`Used slash commands: /${usedSlashCommands.join(', /')}`); }

	const hasModelSwitching = p.modelSwitching.mixedTierSessions > 0 || p.modelSwitching.switchingFrequency > 0;
	const hasAgentMode = p.modeUsage.agent > 0 || p.modeUsage.cli > 0;

	if (totalInteractions >= 30 && (usedSlashCommands.length >= 2 || hasAgentMode)) { stage = 3; }
	if (totalInteractions >= 100 && hasAgentMode && (hasModelSwitching || usedSlashCommands.length >= 3)) { stage = 4; }

	if (hasModelSwitching) {
		evidence.push(`Switched models in ${Math.round(p.modelSwitching.switchingFrequency)}% of sessions`);
		if (stage < 4 && p.modelSwitching.mixedTierSessions > 0) {
			stage = Math.max(stage, 3) as 1 | 2 | 3 | 4;
		}
	}

	if (stage < 2) { tips.push('Try asking Copilot a question using the Chat panel'); }
	if (stage < 3) {
		if (!hasAgentMode) { tips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for multi-file changes'); }
		if (usedSlashCommands.length < 2) { tips.push('Use [slash commands](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like /explain, /fix, or /tests to give structured prompts'); }
	}
	if (stage < 4) {
		if (!hasAgentMode) { tips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for autonomous, multi-step coding tasks'); }
		if (!hasModelSwitching) { tips.push('Experiment with [different models](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_choose-a-language-model) for different tasks - use fast models for simple queries and reasoning models for complex problems'); }
		if (usedSlashCommands.length < 3 && hasAgentMode && hasModelSwitching) { tips.push('Explore more [slash commands](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like /explain, /tests, or /doc to diversify your prompting'); }
	}

	return { stage, evidence, tips };
}

function _scoreContextEngineering(p: UsageAnalysisPeriod): CategoryScore {
	const evidence: string[] = [];
	const tips: string[] = [];
	let stage = 1;

	const refs = p.contextReferences;
	const totalContextRefs = refs.file + refs.selection + refs.symbol + refs.codebase + refs.workspace;
	const usedRefTypeCount = [
		refs.file, refs.selection, refs.symbol, refs.codebase, refs.workspace,
		refs.terminal, refs.vscode, refs.clipboard, refs.changes,
		refs.problemsPanel, refs.outputPanel, refs.terminalLastCommand, refs.terminalSelection,
	].filter(Boolean).length;

	if (refs.file > 0) { evidence.push(`${fmt(refs.file)} #file references`); }
	if (refs.selection > 0) { evidence.push(`${fmt(refs.selection)} #selection references`); }
	if (refs.codebase > 0) { evidence.push(`${fmt(refs.codebase)} #codebase references`); }
	if (refs.workspace > 0) { evidence.push(`${fmt(refs.workspace)} @workspace references`); }
	if (refs.terminal > 0) { evidence.push(`${fmt(refs.terminal)} @terminal references`); }
	if (refs.vscode > 0) { evidence.push(`${fmt(refs.vscode)} @vscode references`); }
	if (refs.clipboard > 0) { evidence.push(`${fmt(refs.clipboard)} #clipboard references`); }
	if (refs.changes > 0) { evidence.push(`${fmt(refs.changes)} #changes references`); }
	if (refs.problemsPanel > 0) { evidence.push(`${fmt(refs.problemsPanel)} #problemsPanel references`); }
	if (refs.outputPanel > 0) { evidence.push(`${fmt(refs.outputPanel)} #outputPanel references`); }
	if (refs.terminalLastCommand > 0) { evidence.push(`${fmt(refs.terminalLastCommand)} #terminalLastCommand references`); }
	if (refs.terminalSelection > 0) { evidence.push(`${fmt(refs.terminalSelection)} #terminalSelection references`); }

	if (totalContextRefs >= 1) { stage = 2; }
	if (usedRefTypeCount >= 3 && totalContextRefs >= 10) { stage = 3; }
	if (usedRefTypeCount >= 5 && totalContextRefs >= 30) { stage = 4; }

	const imageRefs = refs.byKind['copilot.image'] || 0;
	if (imageRefs > 0) {
		evidence.push(`${fmt(imageRefs)} image references (vision)`);
		stage = Math.max(stage, 3) as 1 | 2 | 3 | 4;
	}

	if (stage < 2) { tips.push('Try adding [#file or #selection](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) references to give Copilot more context'); }
	if (stage < 3) { tips.push('Explore [@workspace, #codebase, and @terminal](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) for broader context'); }
	if (stage < 4) {
		const typesStillNeeded = Math.max(0, 5 - usedRefTypeCount);
		const refsStillNeeded = Math.max(0, 30 - totalContextRefs);
		const specializedItems = [
			{ name: 'image attachments', used: imageRefs > 0 },
			{ name: '#changes', used: refs.changes > 0 },
			{ name: '#problemsPanel', used: refs.problemsPanel > 0 },
			{ name: '#outputPanel', used: refs.outputPanel > 0 },
			{ name: '#terminalLastCommand', used: refs.terminalLastCommand > 0 },
			{ name: '#terminalSelection', used: refs.terminalSelection > 0 },
			{ name: '#clipboard', used: refs.clipboard > 0 },
			{ name: '@vscode', used: refs.vscode > 0 },
		];
		const specializedUsedCount = specializedItems.filter(i => i.used).length;
		if (specializedUsedCount >= 2) {
			const allTypesNotUsed = [
				{ name: '#symbol', used: refs.symbol > 0 },
				{ name: '@workspace', used: refs.workspace > 0 },
				{ name: '#codebase', used: refs.codebase > 0 },
				{ name: '@terminal', used: refs.terminal > 0 },
				...specializedItems,
			].filter(i => !i.used).map(i => i.name);
			const gapParts: string[] = [];
			if (typesStillNeeded > 0) { gapParts.push(`${fmt(usedRefTypeCount)} of 5 different reference types used`); }
			if (refsStillNeeded > 0) { gapParts.push(`${fmt(totalContextRefs)} of 30 total references`); }
			if (gapParts.length > 0) {
				const suggest = allTypesNotUsed.slice(0, 3);
				const suggStr = suggest.length > 0 ? ` — try ${suggest.join(', ')}` : '';
				tips.push(`Stage 4 needs ${gapParts.join(' and ')}${suggStr}`);
			}
		} else {
			const specializedNotYetUsed = specializedItems.filter(i => !i.used).map(i => i.name);
			if (specializedNotYetUsed.length > 0) {
				const toMention = specializedNotYetUsed.slice(0, 3);
				const extra = specializedNotYetUsed.length > 3 ? ` and ${specializedNotYetUsed.length - 3} more` : '';
				tips.push(`Try ${toMention.join(', ')}${extra} — see [specialized context variables](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) to reach Stage 4`);
			}
		}
	}

	return { stage, evidence, tips };
}

function _scoreAgentic(p: UsageAnalysisPeriod): CategoryScore {
	const evidence: string[] = [];
	const tips: string[] = [];
	let stage = 1;

	if (p.modeUsage.agent > 0) { evidence.push(`${fmt(p.modeUsage.agent)} agent-mode interactions`); stage = 2; }
	if (p.modeUsage.cli > 0) { evidence.push(`${fmt(p.modeUsage.cli)} CLI interactions`); stage = Math.max(stage, 2) as 1 | 2 | 3 | 4; }
	if (p.toolCalls.total > 0) { evidence.push(`${fmt(p.toolCalls.total)} tool calls executed`); }
	if (p.modeUsage.edit > 0) { evidence.push(`${fmt(p.modeUsage.edit)} edit-mode interactions`); }

	if (p.editScope) {
		const multiFileRate = p.editScope.totalEditedFiles > 0
			? Math.round((p.editScope.multiFileEdits / (p.editScope.singleFileEdits + p.editScope.multiFileEdits)) * 100)
			: 0;
		if (p.editScope.multiFileEdits > 0) {
			evidence.push(`${fmt(p.editScope.multiFileEdits)} multi-file edit sessions (${multiFileRate}%)`);
			stage = Math.max(stage, 2) as 1 | 2 | 3 | 4;
		}
		if (p.editScope.avgFilesPerSession >= 3) {
			evidence.push(`Avg ${p.editScope.avgFilesPerSession.toFixed(1)} files per edit session`);
			stage = Math.max(stage, 3) as 1 | 2 | 3 | 4;
		}
	}

	if (p.agentTypes && p.agentTypes.editsAgent > 0) {
		evidence.push(`${fmt(p.agentTypes.editsAgent)} edits agent sessions`);
		stage = Math.max(stage, 2) as 1 | 2 | 3 | 4;
	}

	const nonAutoToolCount = Object.keys(p.toolCalls.byTool).filter(t => !AUTOMATIC_TOOL_SET.has(t.toLowerCase()) && !t.startsWith('__slash__')).length;
	if ((p.modeUsage.agent + p.modeUsage.cli) >= 10 && nonAutoToolCount >= 3) { stage = 3; }
	if ((p.modeUsage.agent + p.modeUsage.cli) >= 50 && nonAutoToolCount >= 5) { stage = 4; }
	if (p.editScope && p.editScope.multiFileEdits >= 20 && p.editScope.avgFilesPerSession >= 3) {
		stage = Math.max(stage, 4) as 1 | 2 | 3 | 4;
	}

	if (stage < 2) { tips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) — it can run terminal commands, edit files, and explore your codebase autonomously'); }
	if (stage < 3) { tips.push('Use [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for multi-step tasks; let it chain tools like file search, terminal, and code edits'); }
	if (stage < 4) { tips.push('Tackle complex refactoring or debugging tasks in [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for deeper autonomous workflows'); }

	return { stage, evidence, tips };
}

function _scoreToolUsage(p: UsageAnalysisPeriod): CategoryScore {
	const evidence: string[] = [];
	const tips: string[] = [];
	let stage = 1;

	const toolCount = Object.keys(p.toolCalls.byTool).length;
	const nonAutoToolCount = Object.keys(p.toolCalls.byTool).filter(t => !AUTOMATIC_TOOL_SET.has(t.toLowerCase()) && !t.startsWith('__slash__')).length;

	if (nonAutoToolCount > 0) {
		const autoCount = toolCount - nonAutoToolCount;
		const autoNote = autoCount > 0 ? ` (+ ${fmt(autoCount)} automatic)` : '';
		evidence.push(`${fmt(nonAutoToolCount)} intentional tools used${autoNote}`);
		stage = 2;
	} else if (toolCount > 0) {
		evidence.push(`${fmt(toolCount)} tools used (all automatic — agent reads/searches)`);
	}

	if (p.agentTypes) {
		if (p.agentTypes.workspaceAgent > 0) {
			evidence.push(`${fmt(p.agentTypes.workspaceAgent)} @workspace agent sessions`);
			stage = Math.max(stage, 3) as 1 | 2 | 3 | 4;
		}
	}

	const advancedToolFriendlyNames: Record<string, string> = {
		github_pull_request: 'GitHub Pull Request',
		github_repo: 'GitHub Repository',
		run_in_terminal: 'Run In Terminal',
		editFiles: 'Edit Files',
		listFiles: 'List Files'
	};
	const usedAdvanced = Object.keys(advancedToolFriendlyNames).filter(t => (p.toolCalls.byTool[t] || 0) > 0);
	if (usedAdvanced.length > 0) {
		evidence.push(`Advanced tools: ${usedAdvanced.map(t => advancedToolFriendlyNames[t]).join(', ')}`);
		if (usedAdvanced.length >= 2) { stage = Math.max(stage, 3) as 1 | 2 | 3 | 4; }
	}

	const mcpServers = Object.keys(p.mcpTools.byServer);
	if (p.mcpTools.total > 0) {
		evidence.push(`${fmt(p.mcpTools.total)} MCP tool calls across ${mcpServers.length} server(s)`);
		stage = Math.max(stage, 3) as 1 | 2 | 3 | 4;
		if (mcpServers.length >= 2) { stage = 4; }
	}

	if (stage < 2) { tips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) to let Copilot use built-in tools for file operations and terminal commands'); }
	if (stage < 3) {
		if (mcpServers.length === 0) {
			tips.push('Set up [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to connect Copilot to external tools (databases, APIs, cloud services)');
		} else {
			tips.push('Explore [GitHub integrations](https://code.visualstudio.com/docs/copilot/agents/agent-tools) and advanced tools like editFiles and run_in_terminal');
		}
	}
	if (stage < 4) {
		if (mcpServers.length === 1) {
			tips.push('Add more [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to expand Copilot\'s capabilities - check the VS Code MCP registry');
		} else if (mcpServers.length === 0) {
			tips.push('Explore the [VS Code MCP registry](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for tools that integrate with your workflow');
		} else {
			tips.push('You\'re using multiple MCP servers - keep exploring advanced tool combinations');
		}
	}

	return { stage, evidence, tips };
}

function _scoreCustomization(p: UsageAnalysisPeriod, lastCustomizationMatrix: WorkspaceCustomizationMatrix | undefined): CategoryScore {
	const evidence: string[] = [];
	const tips: string[] = [];
	let stage = 1;

	const matrix = lastCustomizationMatrix;
	const totalRepos = matrix?.totalWorkspaces ?? 0;
	const reposWithCustomization = totalRepos - (matrix?.workspacesWithIssues ?? 0);
	const customizationRate = totalRepos > 0 ? (reposWithCustomization / totalRepos) : 0;

	if (totalRepos > 0) { evidence.push(`Worked in ${totalRepos} repositor${totalRepos === 1 ? 'y' : 'ies'}`); }
	if (reposWithCustomization > 0) { stage = 2; }
	if (customizationRate >= 0.3 && reposWithCustomization >= 2) { stage = 3; }
	if (customizationRate >= 0.7 && reposWithCustomization >= 3) { stage = 4; }

	const uniqueModels = [...new Set([...p.modelSwitching.standardModels, ...p.modelSwitching.premiumModels])];
	if (uniqueModels.length >= 3) {
		const hasStage4Models = uniqueModels.length >= 5 && reposWithCustomization >= 3;
		evidence.push(`Used ${uniqueModels.length} different models`);
		if (hasStage4Models) {
			stage = 4;
		} else {
			stage = Math.max(stage, 3) as 1 | 2 | 3 | 4;
		}
	}

	if (stage >= 4) {
		evidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos customized (70%+ with 3+ repos → Stage 4)`);
	} else if (stage >= 3) {
		evidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos customized (30%+ with 2+ repos → Stage 3)`);
	} else if (reposWithCustomization > 0) {
		evidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos with custom instructions or agents.md`);
	}

	if (stage < 2) { tips.push('Create a [.github/copilot-instructions.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) or [CLAUDE.md](https://docs.anthropic.com/en/docs/claude-code/memory) file with project-specific guidelines'); }
	if (stage < 3) { tips.push('Add [custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) to more repositories to standardize your Copilot experience'); }
	if (stage < 4) {
		const uncustomized = totalRepos - reposWithCustomization;
		if (totalRepos > 0 && uncustomized > 0) {
			tips.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos have customization — add [instructions and agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) to the remaining ${fmt(uncustomized)} repo${uncustomized === 1 ? '' : 's'} for Stage 4`);
		} else {
			tips.push('Aim for consistent customization across all projects with [instructions and agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)');
		}
	}
	if (stage >= 4) {
		const uncustomized = totalRepos - reposWithCustomization;
		if (uncustomized > 0) {
			const missingCustomizationRepos = (matrix?.workspaces || [])
				.filter(row => Object.values(row.typeStatuses).every(status => status === '❌'));
			const prioritizedMissingRepos = missingCustomizationRepos
				.filter(row => !row.workspacePath.startsWith('<unresolved:'))
				.sort((a, b) => {
					if (b.interactionCount !== a.interactionCount) { return b.interactionCount - a.interactionCount; }
					return b.sessionCount - a.sessionCount;
				})
				.slice(0, 3);
			const summaryTip = `${fmt(uncustomized)} repo${uncustomized === 1 ? '' : 's'} still missing customization — add [instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), [agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), or [MCP configs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for full coverage.`;
			if (prioritizedMissingRepos.length > 0) {
				const repoLines = prioritizedMissingRepos.map(row =>
					`${row.workspaceName} (${fmt(row.interactionCount)} interaction${row.interactionCount === 1 ? '' : 's'})`
				).join('\n');
				tips.push(`${summaryTip}\n\nTop repos to customize first:\n${repoLines}`);
			} else {
				tips.push(summaryTip);
			}
		} else {
			tips.push('All repos customized! Keep instructions up to date and add [skill files](https://code.visualstudio.com/docs/copilot/customization/agent-skills) or [MCP server configs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for deeper integration');
		}
	}

	return { stage, evidence, tips };
}

function _scoreWorkflowIntegration(p: UsageAnalysisPeriod): CategoryScore {
	const evidence: string[] = [];
	const tips: string[] = [];
	let stage = 1;

	if (p.sessions >= 3) { evidence.push(`${fmt(p.sessions)} sessions in the last 30 days`); stage = 2; }

	if (p.applyUsage && p.applyUsage.totalCodeBlocks > 0) {
		const applyRatePercent = Math.round(p.applyUsage.applyRate);
		evidence.push(`${applyRatePercent}% code block apply rate (${fmt(p.applyUsage.totalApplies)}/${fmt(p.applyUsage.totalCodeBlocks)})`);
		if (applyRatePercent >= 50) { stage = Math.max(stage, 2) as 1 | 2 | 3 | 4; }
	}

	if (p.sessionDuration && p.sessionDuration.avgDurationMs > 0) {
		const avgMinutes = Math.round(p.sessionDuration.avgDurationMs / 60000);
		evidence.push(`Avg ${avgMinutes}min session duration`);
	}

	const totalContextRefs = p.contextReferences.file + p.contextReferences.selection +
		p.contextReferences.symbol + p.contextReferences.codebase + p.contextReferences.workspace;
	const modesUsed = [p.modeUsage.ask > 0, p.modeUsage.agent > 0, p.modeUsage.cli > 0].filter(Boolean).length;
	if (modesUsed >= 2) {
		evidence.push(`Uses ${modesUsed} modes (ask/agent/cli)`);
		stage = Math.max(stage, 3) as 1 | 2 | 3 | 4;
	}

	const hasExplicitContext = totalContextRefs >= 10;
	if (hasExplicitContext) {
		evidence.push(`${fmt(totalContextRefs)} explicit context references`);
		if (totalContextRefs >= 20) { stage = Math.max(stage, 3) as 1 | 2 | 3 | 4; }
	}

	if (p.sessions >= 15 && modesUsed >= 2 && totalContextRefs >= 20) {
		stage = 4;
		evidence.push('Deep integration: regular usage with multi-mode and explicit context');
	}

	if (stage < 2) { tips.push('Use AI more regularly - even for quick questions'); }
	if (stage < 3) {
		if (modesUsed < 2) { tips.push('Combine [ask mode with agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) in your daily workflow'); }
		if (totalContextRefs < 10) { tips.push('Use explicit [context references](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like #file, @workspace, and #selection'); }
	}
	if (stage < 4) {
		if (totalContextRefs < 20) { tips.push('Make explicit context a habit - use [#file, @workspace, and other references](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) consistently'); }
		tips.push('Make AI part of every coding task: planning, coding, testing, and reviewing');
	}

	return { stage, evidence, tips };
}


export function getFluencyLevelData(isDebugMode: boolean): {
    categories: Array<{
      category: string;
      icon: string;
      levels: Array<{
        stage: number;
        label: string;
        description: string;
        thresholds: string[];
        tips: string[];
      }>;
    }>;
    isDebugMode: boolean;
  } {
    return {
      isDebugMode,
      categories: [
        {
          category: "Prompt Engineering",
          icon: "💬",
          levels: [
            {
              stage: 1,
              label: "Stage 1: AI Skeptic",
              description: "Rarely uses AI tools or uses only basic features",
              thresholds: [
                "Fewer than 5 total interactions in 30 days",
                "Minimal multi-turn conversations",
                "No slash commands or agent mode usage",
              ],
              tips: [
                "Try asking AI a question using the Chat panel — [▶ Chat in IDE video](https://tech.hub.ms/github-copilot/videos/chat-in-ide)",
                "Start with simple queries to get familiar with the interface",
              ],
            },
            {
              stage: 2,
              label: "Stage 2: AI Explorer",
              description: "Exploring AI capabilities with occasional use",
              thresholds: [
                "At least 5 total interactions",
                "Average 3+ exchanges per session shows iterative refinement",
                "Beginning to use slash commands or agent mode",
              ],
              tips: [
                "Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for multi-file changes — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)",
                "Use [slash commands](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like /explain, /fix, or /tests to give structured prompts",
                "Experiment with multi-turn conversations to refine responses",
              ],
            },
            {
              stage: 3,
              label: "Stage 3: AI Collaborator",
              description: "Regular, purposeful use across multiple features",
              thresholds: [
                "At least 30 total interactions",
                "Using 2+ slash commands or agent mode regularly",
                "Average 5+ exchanges per session OR model switching in sessions",
                "Shows model switching awareness (mixed-tier sessions)",
              ],
              tips: [
                "Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for autonomous, multi-step coding tasks",
                "Experiment with [different models](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_choose-a-language-model) for different tasks - use fast models for simple queries and reasoning models for complex problems — [▶ Model selection video](https://tech.hub.ms/github-copilot/videos/model-selection)",
                "Explore more [slash commands](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like /explain, /tests, or /doc to diversify your prompting",
              ],
            },
            {
              stage: 4,
              label: "Stage 4: AI Strategist",
              description:
                "Strategic, advanced use leveraging the full AI ecosystem",
              thresholds: [
                "At least 100 total interactions",
                "Using agent mode regularly",
                "Active model switching (switches in sessions) OR 3+ diverse slash commands",
                "Demonstrates strategic choice of models and commands for different tasks",
              ],
              tips: [
                "You're at the highest level!",
                "Continue exploring advanced combinations of models, modes, and commands",
              ],
            },
          ],
        },
        {
          category: "Context Engineering",
          icon: "📎",
          levels: [
            {
              stage: 1,
              label: "Stage 1: AI Skeptic",
              description: "Not using explicit context references",
              thresholds: [
                "Zero explicit context references (#file, #selection, @workspace, etc.)",
              ],
              tips: [
                "Try adding [#file or #selection](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) references to give Copilot more context",
                "Start with #file to reference specific files in your prompts",
              ],
            },
            {
              stage: 2,
              label: "Stage 2: AI Explorer",
              description: "Beginning to use basic context references",
              thresholds: [
                "At least 1 context reference used",
                "Exploring basic references like #file or #selection",
              ],
              tips: [
                "Explore [@workspace, #codebase, and @terminal](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) for broader context",
                "Try combining multiple context types in a single query",
              ],
            },
            {
              stage: 3,
              label: "Stage 3: AI Collaborator",
              description: "Regular use of diverse context types",
              thresholds: [
                "At least 3 different context reference types used",
                "At least 10 total context references",
                "May include image references (vision capabilities)",
              ],
              tips: [
                "Try [image attachments](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts), #changes, #problemsPanel, and other specialized context variables",
                "Experiment with @terminal and @vscode for IDE-level context",
              ],
            },
            {
              stage: 4,
              label: "Stage 4: AI Strategist",
              description: "Strategic use of advanced context engineering",
              thresholds: [
                "At least 5 different context reference types used",
                "At least 30 total context references",
                "Using specialized references like #changes, #problemsPanel, #outputPanel, etc.",
              ],
              tips: [
                "You're at the highest level!",
                "Continue mastering context engineering for optimal results",
              ],
            },
          ],
        },
        {
          category: "Agentic",
          icon: "🤖",
          levels: [
            {
              stage: 1,
              label: "Stage 1: AI Skeptic",
              description: "Not using agent mode or autonomous features",
              thresholds: [
                "Zero agent-mode interactions",
                "No tool calls executed",
                "Not using edit mode or multi-file capabilities",
              ],
              tips: [
                "Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) — it can run terminal commands, edit files, and explore your codebase autonomously — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)",
                "Start with simple tasks to see how agent mode works",
              ],
            },
            {
              stage: 2,
              label: "Stage 2: AI Explorer",
              description: "Beginning to explore agent mode",
              thresholds: [
                "At least 1 agent-mode interaction OR",
                "Using edit mode OR",
                "At least 1 multi-file edit session",
              ],
              tips: [
                "Use [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for multi-step tasks; let it chain tools like file search, terminal, and code edits — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)",
                "Try edit mode for focused code changes",
              ],
            },
            {
              stage: 3,
              label: "Stage 3: AI Collaborator",
              description: "Regular use of agent mode with diverse tools",
              thresholds: [
                "At least 10 agent-mode interactions AND 3+ intentional tools used OR",
                "Average 3+ files per edit session OR",
                "Using edits agent for focused editing tasks",
              ],
              tips: [
                "Tackle complex refactoring or debugging tasks in [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for deeper autonomous workflows",
                "Let agent mode handle multi-step tasks that span multiple files — [▶ Multi-file Edits video](https://tech.hub.ms/github-copilot/videos/multi-file-edits)",
              ],
            },
            {
              stage: 4,
              label: "Stage 4: AI Strategist",
              description: "Heavy, strategic use of autonomous features",
              thresholds: [
                "At least 50 agent-mode interactions AND 5+ intentional tools used OR",
                "At least 20 multi-file edits with 3+ files per session average",
                "Demonstrates mastery of agent orchestration",
              ],
              tips: [
                "You're at the highest level!",
                "Continue leveraging agent mode for complex, multi-step workflows",
              ],
            },
          ],
        },
        {
          category: "Tool Usage",
          icon: "🔧",
          levels: [
            {
              stage: 1,
              label: "Stage 1: AI Skeptic",
              description: "Not using tools beyond basic chat",
              thresholds: [
                "Zero intentional tools used (automatic tools like file reads and searches are excluded)",
                "No MCP servers configured",
                "No workspace agent sessions",
              ],
              tips: [
                "Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) to let Copilot use built-in tools for file operations and terminal commands — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)",
                "Explore the built-in tools available in agent mode",
              ],
            },
            {
              stage: 2,
              label: "Stage 2: AI Explorer",
              description: "Beginning to use basic tools",
              thresholds: [
                "At least 1 intentional tool used (e.g. run_in_terminal, editFiles, websearch, MCP tools)",
                "Automatic tools (file reads, searches, error checks) do not count",
              ],
              tips: [
                "Set up [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to connect Copilot to external tools (databases, APIs, cloud services) — [▶ MCP with Azure and GitHub](https://tech.hub.ms/github-copilot/videos/mcp-with-azure-and-github)",
                "Explore [GitHub integrations](https://code.visualstudio.com/docs/copilot/agents/agent-tools) and advanced tools like editFiles and run_in_terminal",
              ],
            },
            {
              stage: 3,
              label: "Stage 3: AI Collaborator",
              description: "Regular use of diverse tools and integrations",
              thresholds: [
                "Using @workspace agent OR",
                "Using 2+ advanced tools (GitHub PR, GitHub Repo, terminal, editFiles, listFiles) OR",
                "Using at least 1 MCP server",
              ],
              tips: [
                "Add more [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to expand Copilot's capabilities - check the VS Code MCP registry — [▶ MCP with Azure and GitHub](https://tech.hub.ms/github-copilot/videos/mcp-with-azure-and-github)",
                "Explore advanced tool combinations for complex workflows",
              ],
            },
            {
              stage: 4,
              label: "Stage 4: AI Strategist",
              description:
                "Strategic use of multiple MCP servers and advanced tools",
              thresholds: [
                "Using 2+ MCP servers",
                "Leveraging multiple advanced tools strategically",
              ],
              tips: [
                "You're at the highest level!",
                "Keep exploring advanced tool combinations and new MCP servers",
              ],
            },
          ],
        },
        {
          category: "Customization",
          icon: "⚙️",
          levels: [
            {
              stage: 1,
              label: "Stage 1: AI Skeptic",
              description: "Using default Copilot without customization",
              thresholds: [
                "No repositories with custom instructions, agents.md, or CLAUDE.md",
                "Using fewer than 3 different models",
              ],
              tips: [
                "Create a [.github/copilot-instructions.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) or [CLAUDE.md](https://docs.anthropic.com/en/docs/claude-code/memory) file with project-specific guidelines — [▶ User Instructions video](https://tech.hub.ms/github-copilot/videos/user-instructions)",
                "Start customizing Copilot or Claude Code for your workflow",
              ],
            },
            {
              stage: 2,
              label: "Stage 2: AI Explorer",
              description: "Beginning to customize Copilot",
              thresholds: [
                "At least 1 repository with custom instructions or agents.md",
              ],
              tips: [
                "Add [custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) to more repositories to standardize your Copilot experience — [▶ User Instructions video](https://tech.hub.ms/github-copilot/videos/user-instructions)",
                "Experiment with [different models](https://tech.hub.ms/github-copilot/videos/model-selection) for different tasks",
              ],
            },
            {
              stage: 3,
              label: "Stage 3: AI Collaborator",
              description: "Regular customization across repositories",
              thresholds: [
                "30%+ of repositories have customization (with 2+ repos) OR",
                "Using 3+ different models strategically",
              ],
              tips: [
                "Aim for consistent customization across all projects with [instructions and agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)",
                "Explore 5+ models to match tasks with optimal model capabilities — [▶ Model selection video](https://tech.hub.ms/github-copilot/videos/model-selection)",
              ],
            },
            {
              stage: 4,
              label: "Stage 4: AI Strategist",
              description: "Comprehensive customization strategy",
              thresholds: [
                "70%+ customization adoption rate with 3+ repos OR",
                "Using 5+ different models with 3+ repos customized",
              ],
              tips: [
                "You're at the highest level!",
                "Continue refining your customization strategy",
              ],
            },
          ],
        },
        {
          category: "Workflow Integration",
          icon: "🔄",
          levels: [
            {
              stage: 1,
              label: "Stage 1: AI Skeptic",
              description: "Minimal integration into daily workflow",
              thresholds: [
                "Fewer than 3 sessions in 30 days",
                "Using only 1 mode (ask OR agent)",
                "Fewer than 10 explicit context references",
              ],
              tips: [
                "Use Copilot more regularly - even for quick questions — [▶ Chat in IDE video](https://tech.hub.ms/github-copilot/videos/chat-in-ide)",
                "Make Copilot part of your daily coding routine",
              ],
            },
            {
              stage: 2,
              label: "Stage 2: AI Explorer",
              description: "Occasional integration with some regularity",
              thresholds: [
                "At least 3 sessions in 30 days OR",
                "50%+ code block apply rate",
              ],
              tips: [
                "Combine [ask mode with agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) in your daily workflow — [▶ Agent Mode video](https://tech.hub.ms/github-copilot/videos/agent-mode)",
                "Use explicit [context references](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like #file, @workspace, and #selection",
              ],
            },
            {
              stage: 3,
              label: "Stage 3: AI Collaborator",
              description: "Regular workflow integration",
              thresholds: [
                "Using 2 modes (ask AND agent) OR",
                "At least 20 explicit context references",
              ],
              tips: [
                "Make explicit context a habit - use [#file, @workspace, and other references](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) consistently",
                "Make Copilot part of every coding task: planning, coding, testing, and reviewing",
              ],
            },
            {
              stage: 4,
              label: "Stage 4: AI Strategist",
              description: "Deep integration across all development activities",
              thresholds: [
                "At least 15 sessions",
                "Using 2+ modes (ask + agent)",
                "At least 20 explicit context references",
                "Shows regular, purposeful usage pattern",
              ],
              tips: [
                "You're at the highest level!",
                "Continue integrating Copilot into every aspect of your development workflow",
              ],
            },
          ],
        },
      ],
    };
  }

  /**
   * Calculates a fluency stage (1-4) for a team member based on aggregated Azure Table Storage metrics.
   * Applies the same 6-category scoring thresholds as calculateMaturityScores().
   */
export function calculateFluencyScoreForTeamMember(fd: {
    askModeCount: number; editModeCount: number; agentModeCount: number;
    planModeCount: number; customAgentModeCount: number; cliModeCount: number;
    toolCallsTotal: number; toolCallsByTool: Record<string, number>;
    ctxFile: number; ctxSelection: number; ctxSymbol: number;
    ctxCodebase: number; ctxWorkspace: number; ctxTerminal: number;
    ctxVscode: number; ctxClipboard: number; ctxChanges: number;
    ctxProblemsPanel: number; ctxOutputPanel: number;
    ctxTerminalLastCommand: number; ctxTerminalSelection: number;
    ctxByKind: Record<string, number>;
    mcpTotal: number; mcpByServer: Record<string, number>;
    mixedTierSessions: number; switchingFreqSum: number; switchingFreqCount: number;
    standardModels: Set<string>; premiumModels: Set<string>;
    multiFileEdits: number; filesPerEditSum: number; filesPerEditCount: number;
    editsAgentCount: number; workspaceAgentCount: number;
    repositories: Set<string>; repositoriesWithCustomization: Set<string>;
    applyRateSum: number; applyRateCount: number;
    multiTurnSessions: number; turnsPerSessionSum: number; turnsPerSessionCount: number;
    sessionCount: number; durationMsSum: number; durationMsCount: number;
  }, dashboardSessions: number): { stage: number; label: string; categories: { category: string; icon: string; stage: number; tips: string[] }[] } {
    const stageLabels: Record<number, string> = {
      1: "Stage 1: AI Skeptic",
      2: "Stage 2: AI Explorer",
      3: "Stage 3: AI Collaborator",
      4: "Stage 4: AI Strategist",
    };

    const totalInteractions = fd.askModeCount + fd.editModeCount + fd.agentModeCount + fd.cliModeCount;
    const avgTurnsPerSession = fd.turnsPerSessionCount > 0 ? fd.turnsPerSessionSum / fd.turnsPerSessionCount : 0;
    const switchingFrequency = fd.switchingFreqCount > 0 ? fd.switchingFreqSum / fd.switchingFreqCount : 0;
    const hasModelSwitching = fd.mixedTierSessions > 0 || switchingFrequency > 0;
    const hasAgentMode = (fd.agentModeCount + fd.cliModeCount) > 0;
    const toolCount = Object.keys(fd.toolCallsByTool).length;
    // Exclude __slash__ pseudo-entries from real tool counts (they track Claude slash commands, not actual tool calls)
    const nonAutoToolCount = Object.keys(fd.toolCallsByTool).filter(t => !AUTOMATIC_TOOL_SET.has(t.toLowerCase()) && !t.startsWith('__slash__')).length;
    const avgFilesPerSession = fd.filesPerEditCount > 0 ? fd.filesPerEditSum / fd.filesPerEditCount : 0;
    const avgApplyRate = fd.applyRateCount > 0 ? fd.applyRateSum / fd.applyRateCount : 0;
    const totalContextRefs = fd.ctxFile + fd.ctxSelection + fd.ctxSymbol + fd.ctxCodebase + fd.ctxWorkspace;

    // 1. Prompt Engineering
    let peStage = 1;
    // VS Code Copilot slash commands (stored as tool calls by the session parser)
    const slashCmds = ["explain", "fix", "tests", "doc", "generate", "optimize", "new", "newNotebook", "search", "fixTestFailure", "setupTests"];
    // Claude Code slash commands (stored with __slash__ prefix to avoid inflating tool counts)
    const claudeSlashCmds = ["review", "bug", "think", "compact", "pr_comments"];
    const usedSlashCommands = [
      ...slashCmds.filter(cmd => (fd.toolCallsByTool[cmd] ?? 0) > 0),
      ...claudeSlashCmds.filter(cmd => (fd.toolCallsByTool[`__slash__${cmd}`] ?? 0) > 0),
    ];
    if (avgTurnsPerSession >= 3) { peStage = Math.max(peStage, 2); }
    if (avgTurnsPerSession >= 5) { peStage = Math.max(peStage, 3); }
    if (totalInteractions >= 5) { peStage = Math.max(peStage, 2); }
    if (totalInteractions >= 30 && (usedSlashCommands.length >= 2 || hasAgentMode)) { peStage = Math.max(peStage, 3); }
    if (totalInteractions >= 100 && hasAgentMode && (hasModelSwitching || usedSlashCommands.length >= 3)) { peStage = 4; }
    if (hasModelSwitching && fd.mixedTierSessions > 0) { peStage = Math.max(peStage, 3); }
    const peTips: string[] = [];
    if (peStage < 2) { peTips.push("Try asking Copilot a question using the Chat panel"); }
    if (peStage < 3) {
      if (!hasAgentMode) { peTips.push("Try agent mode for multi-file changes"); }
      if (usedSlashCommands.length < 2) { peTips.push("Use slash commands like /explain, /fix, or /tests for structured prompts"); }
    }
    if (peStage < 4) {
      if (!hasAgentMode) { peTips.push("Try agent mode for autonomous, multi-step coding tasks"); }
      if (!hasModelSwitching) { peTips.push("Experiment with different models — fast models for simple queries, reasoning models for complex problems"); }
      if (usedSlashCommands.length < 3 && hasAgentMode && hasModelSwitching) { peTips.push("Explore more slash commands like /explain, /tests, or /doc"); }
    }

    // 2. Context Engineering
    let ceStage = 1;
    const usedRefTypeCount = [
      fd.ctxFile, fd.ctxSelection, fd.ctxSymbol, fd.ctxCodebase, fd.ctxWorkspace,
      fd.ctxTerminal, fd.ctxVscode, fd.ctxClipboard, fd.ctxChanges,
      fd.ctxProblemsPanel, fd.ctxOutputPanel, fd.ctxTerminalLastCommand, fd.ctxTerminalSelection,
    ].filter(v => v > 0).length;
    if (totalContextRefs >= 1) { ceStage = 2; }
    if (usedRefTypeCount >= 3 && totalContextRefs >= 10) { ceStage = 3; }
    if (usedRefTypeCount >= 5 && totalContextRefs >= 30) { ceStage = 4; }
    if ((fd.ctxByKind["copilot.image"] ?? 0) > 0) { ceStage = Math.max(ceStage, 3); }
    const ceTips: string[] = [];
    if (ceStage < 2) { ceTips.push("Add #file or #selection references to give Copilot more context"); }
    if (ceStage < 3) { ceTips.push("Explore @workspace, #codebase, and @terminal for broader context"); }
    if (ceStage < 4) {
        const typesStillNeeded = Math.max(0, 5 - usedRefTypeCount);
        const refsStillNeeded = Math.max(0, 30 - totalContextRefs);
        const specializedItems = [
            { name: 'image attachments', used: (fd.ctxByKind["copilot.image"] ?? 0) > 0 },
            { name: '#changes', used: fd.ctxChanges > 0 },
            { name: '#problemsPanel', used: fd.ctxProblemsPanel > 0 },
            { name: '#outputPanel', used: fd.ctxOutputPanel > 0 },
            { name: '#terminalLastCommand', used: fd.ctxTerminalLastCommand > 0 },
            { name: '#terminalSelection', used: fd.ctxTerminalSelection > 0 },
            { name: '#clipboard', used: fd.ctxClipboard > 0 },
            { name: '@vscode', used: fd.ctxVscode > 0 },
        ];
        const specializedUsedCount = specializedItems.filter(i => i.used).length;
        if (specializedUsedCount >= 2) {
            // User already uses multiple specialized context techniques — show a concrete gap tip.
            const allTypesNotUsed = [
                { name: '#symbol', used: fd.ctxSymbol > 0 },
                { name: '@workspace', used: fd.ctxWorkspace > 0 },
                { name: '#codebase', used: fd.ctxCodebase > 0 },
                { name: '@terminal', used: fd.ctxTerminal > 0 },
                ...specializedItems,
            ].filter(i => !i.used).map(i => i.name);
            const gapParts: string[] = [];
            if (typesStillNeeded > 0) { gapParts.push(`${fmt(usedRefTypeCount)} of 5 different reference types used`); }
            if (refsStillNeeded > 0) { gapParts.push(`${fmt(totalContextRefs)} of 30 total references`); }
            if (gapParts.length > 0) {
                const suggest = allTypesNotUsed.slice(0, 3);
                const suggStr = suggest.length > 0 ? ` — try ${suggest.join(', ')}` : '';
                ceTips.push(`Stage 4 needs ${gapParts.join(' and ')}${suggStr}`);
            }
        } else {
            // User hasn't explored many specialized vars yet — suggest them.
            const specializedNotYetUsed = specializedItems.filter(i => !i.used).map(i => i.name);
            if (specializedNotYetUsed.length > 0) {
                const toMention = specializedNotYetUsed.slice(0, 3);
                const extra = specializedNotYetUsed.length > 3 ? ` and ${specializedNotYetUsed.length - 3} more` : '';
                ceTips.push(`Try ${toMention.join(', ')}${extra} — see specialized context variables to reach Stage 4`);
            }
        }
    }

    // 3. Agentic
    let agStage = 1;
    if (hasAgentMode) { agStage = 2; }
    if (fd.multiFileEdits > 0) { agStage = Math.max(agStage, 2); }
    if (avgFilesPerSession >= 3) { agStage = Math.max(agStage, 3); }
    if (fd.editsAgentCount > 0) { agStage = Math.max(agStage, 2); }
    if (fd.agentModeCount >= 10 && nonAutoToolCount >= 3) { agStage = Math.max(agStage, 3); }
    if (fd.agentModeCount >= 50 && nonAutoToolCount >= 5) { agStage = 4; }
    if (fd.multiFileEdits >= 20 && avgFilesPerSession >= 3) { agStage = Math.max(agStage, 4); }
    const agTips: string[] = [];
    if (agStage < 2) { agTips.push("Try agent mode — it can run terminal commands, edit files, and explore codebases autonomously"); }
    if (agStage < 3) { agTips.push("Use agent mode for multi-step tasks; let it chain tools like file search, terminal, and code edits"); }
    if (agStage < 4) { agTips.push("Tackle complex refactoring or debugging tasks in agent mode for deeper autonomous workflows"); }

    // 4. Tool Usage
    let tuStage = 1;
    if (nonAutoToolCount > 0) { tuStage = 2; }
    if (fd.workspaceAgentCount > 0) { tuStage = Math.max(tuStage, 3); }
    const advancedToolIds = ["github_pull_request", "github_repo", "run_in_terminal", "editFiles", "listFiles"];
    const usedAdvancedCount = advancedToolIds.filter(t => (fd.toolCallsByTool[t] ?? 0) > 0).length;
    if (usedAdvancedCount >= 2) { tuStage = Math.max(tuStage, 3); }
    if (fd.mcpTotal > 0) { tuStage = Math.max(tuStage, 3); }
    if (Object.keys(fd.mcpByServer).length >= 2) { tuStage = 4; }
    const tuTips: string[] = [];
    if (tuStage < 2) { tuTips.push("Try agent mode to let Copilot use built-in tools for file operations and terminal commands"); }
    if (tuStage < 3) {
      if (fd.mcpTotal === 0) { tuTips.push("Set up MCP servers to connect Copilot to external tools (databases, APIs, cloud services)"); }
      else { tuTips.push("Explore GitHub integrations and advanced tools like editFiles and run_in_terminal"); }
    }
    if (tuStage < 4) {
      if (Object.keys(fd.mcpByServer).length === 1) { tuTips.push("Add more MCP servers to expand Copilot's capabilities"); }
      else if (fd.mcpTotal === 0) { tuTips.push("Explore MCP servers for tools that integrate with your workflow"); }
    }

    // 5. Customization
    let cuStage = 1;
    const totalRepos = fd.repositories.size;
    const reposWithCustomization = fd.repositoriesWithCustomization.size;
    const customizationRate = totalRepos > 0 ? reposWithCustomization / totalRepos : 0;
    if (reposWithCustomization > 0) { cuStage = 2; }
    if (customizationRate >= 0.3 && reposWithCustomization >= 2) { cuStage = 3; }
    if (customizationRate >= 0.7 && reposWithCustomization >= 3) { cuStage = 4; }
    const uniqueModels = new Set([...fd.standardModels, ...fd.premiumModels]);
    if (uniqueModels.size >= 3) { cuStage = Math.max(cuStage, 3); }
    if (uniqueModels.size >= 5 && reposWithCustomization >= 3) { cuStage = 4; }
    const cuTips: string[] = [];
    if (cuStage < 2) { cuTips.push("Create a .github/copilot-instructions.md or CLAUDE.md file with project-specific guidelines"); }
    if (cuStage < 3) { cuTips.push("Add custom instructions to more repositories to standardize your Copilot experience"); }
    if (cuStage < 4) {
      const uncustomized = totalRepos - reposWithCustomization;
      if (uncustomized > 0) { cuTips.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos customized — add instructions to the remaining ${fmt(uncustomized)} for Stage 4`); }
      else { cuTips.push("Aim for consistent customization across all projects with instructions and agents.md"); }
    }
    if (cuStage >= 4) {
      const uncustomized = totalRepos - reposWithCustomization;
      if (uncustomized > 0) {
        cuTips.push(`${fmt(uncustomized)} repo${uncustomized === 1 ? '' : 's'} still missing customization — add instructions, agents.md, or MCP configs for full coverage`);
      } else {
        cuTips.push("All repos customized! Keep instructions up to date and add skill files or MCP server configs for deeper integration");
      }
    }

    // 6. Workflow Integration
    const effectiveSessions = Math.max(dashboardSessions, fd.sessionCount);
    let wiStage = 1;
    if (effectiveSessions >= 3) { wiStage = 2; }
    if (avgApplyRate >= 50) { wiStage = Math.max(wiStage, 2); }
    const modesUsed = [fd.askModeCount > 0, fd.agentModeCount > 0].filter(Boolean).length;
    if (modesUsed >= 2) { wiStage = Math.max(wiStage, 3); }
    if (totalContextRefs >= 20) { wiStage = Math.max(wiStage, 3); }
    if (effectiveSessions >= 15 && modesUsed >= 2 && totalContextRefs >= 20) { wiStage = 4; }
    const wiTips: string[] = [];
    if (wiStage < 2) { wiTips.push("Use Copilot more regularly — even for quick questions"); }
    if (wiStage < 3) {
      if (modesUsed < 2) { wiTips.push("Combine ask mode with agent mode in your daily workflow"); }
      if (totalContextRefs < 10) { wiTips.push("Use explicit context references like #file, @workspace, and #selection"); }
    }
    if (wiStage < 4) {
      if (totalContextRefs < 20) { wiTips.push("Make explicit context a habit — use #file, @workspace, and other references consistently"); }
      wiTips.push("Make Copilot part of every coding task: planning, coding, testing, and reviewing");
    }

    // Overall: median of 6 category stages
    const scores = [peStage, ceStage, agStage, tuStage, cuStage, wiStage].sort((a, b) => a - b);
    const mid = Math.floor(scores.length / 2);
    const overallStage = scores.length % 2 === 0
      ? Math.round((scores[mid - 1] + scores[mid]) / 2)
      : scores[mid];

    return {
      stage: overallStage,
      label: stageLabels[overallStage] ?? `Stage ${overallStage}`,
      categories: [
        { category: "Prompt Engineering", icon: "💬", stage: peStage, tips: peTips },
        { category: "Context Engineering", icon: "📎", stage: ceStage, tips: ceTips },
        { category: "Agentic", icon: "🤖", stage: agStage, tips: agTips },
        { category: "Tool Usage", icon: "🔧", stage: tuStage, tips: tuTips },
        { category: "Customization", icon: "⚙️", stage: cuStage, tips: cuTips },
        { category: "Workflow Integration", icon: "🔄", stage: wiStage, tips: wiTips },
      ],
    };
  }

/**
 * Calculate maturity scores across 6 categories using last 30 days of usage data.
 * Each category is scored 1-4 based on threshold rules.
 * Overall stage = median of the 6 category scores.
 * @param useCache If true, use cached usage stats. If false, force recalculation.
 */
export async function calculateMaturityScores(lastCustomizationMatrix: WorkspaceCustomizationMatrix | undefined, calculateUsageAnalysisStatsFn: (useCache?: boolean) => Promise<UsageAnalysisStats>, useCache = true): Promise<{
	overallStage: number;
	overallLabel: string;
	categories: { category: string; icon: string; stage: number; evidence: string[]; tips: string[] }[];
	period: UsageAnalysisPeriod;
	lastUpdated: string;
}> {
	const stats = await calculateUsageAnalysisStatsFn(useCache);
	const p = stats.last30Days;

	const stageLabels: Record<number, string> = {
		1: 'Stage 1: AI Skeptic',
		2: 'Stage 2: AI Explorer',
		3: 'Stage 3: AI Collaborator',
		4: 'Stage 4: AI Strategist'
	};

	const pe = _scorePromptEngineering(p);
	const ce = _scoreContextEngineering(p);
	const ag = _scoreAgentic(p);
	const tu = _scoreToolUsage(p);
	const cu = _scoreCustomization(p, lastCustomizationMatrix);
	const wi = _scoreWorkflowIntegration(p);

	const scores = [pe.stage, ce.stage, ag.stage, tu.stage, cu.stage, wi.stage].sort((a, b) => a - b);
	const mid = Math.floor(scores.length / 2);
	const overallStage = scores.length % 2 === 0
		? Math.round((scores[mid - 1] + scores[mid]) / 2)
		: scores[mid];

	return {
		overallStage,
		overallLabel: stageLabels[overallStage] || `Stage ${overallStage}`,
		categories: [
			{ category: 'Prompt Engineering', icon: '💬', stage: pe.stage, evidence: pe.evidence, tips: pe.tips },
			{ category: 'Context Engineering', icon: '📎', stage: ce.stage, evidence: ce.evidence, tips: ce.tips },
			{ category: 'Agentic', icon: '🤖', stage: ag.stage, evidence: ag.evidence, tips: ag.tips },
			{ category: 'Tool Usage', icon: '🔧', stage: tu.stage, evidence: tu.evidence, tips: tu.tips },
			{ category: 'Customization', icon: '⚙️', stage: cu.stage, evidence: cu.evidence, tips: cu.tips },
			{ category: 'Workflow Integration', icon: '🔄', stage: wi.stage, evidence: wi.evidence, tips: wi.tips }
		],
		period: p,
		lastUpdated: stats.lastUpdated.toISOString()
	};
}
