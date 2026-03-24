/**
 * Maturity/fluency scoring functions.
 * Computes Copilot Fluency Score and related metrics.
 */
import type {
	DetailedStats,
	UsageAnalysisStats,
	WorkspaceCustomizationMatrix,
	UsageAnalysisPeriod,
} from './types';

/** Format a number with thousand separators for display. */
function fmt(n: number): string {
	return n.toLocaleString('en-US');
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
              label: "Stage 1: Copilot Skeptic",
              description: "Rarely uses Copilot or uses only basic features",
              thresholds: [
                "Fewer than 5 total interactions in 30 days",
                "Minimal multi-turn conversations",
                "No slash commands or agent mode usage",
              ],
              tips: [
                "Try asking Copilot a question using the Chat panel — [▶ Chat in IDE video](https://tech.hub.ms/github-copilot/videos/chat-in-ide)",
                "Start with simple queries to get familiar with the interface",
              ],
            },
            {
              stage: 2,
              label: "Stage 2: Copilot Explorer",
              description: "Exploring Copilot capabilities with occasional use",
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
              label: "Stage 3: Copilot Collaborator",
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
              label: "Stage 4: Copilot Strategist",
              description:
                "Strategic, advanced use leveraging the full Copilot ecosystem",
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
              label: "Stage 1: Copilot Skeptic",
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
              label: "Stage 2: Copilot Explorer",
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
              label: "Stage 3: Copilot Collaborator",
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
              label: "Stage 4: Copilot Strategist",
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
              label: "Stage 1: Copilot Skeptic",
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
              label: "Stage 2: Copilot Explorer",
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
              label: "Stage 3: Copilot Collaborator",
              description: "Regular use of agent mode with diverse tools",
              thresholds: [
                "At least 10 agent-mode interactions AND 3+ unique tools used OR",
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
              label: "Stage 4: Copilot Strategist",
              description: "Heavy, strategic use of autonomous features",
              thresholds: [
                "At least 50 agent-mode interactions AND 5+ tool types used OR",
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
              label: "Stage 1: Copilot Skeptic",
              description: "Not using tools beyond basic chat",
              thresholds: [
                "Zero unique tools used",
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
              label: "Stage 2: Copilot Explorer",
              description: "Beginning to use basic tools",
              thresholds: [
                "At least 1 unique tool used",
                "Using basic agent mode tools",
              ],
              tips: [
                "Set up [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to connect Copilot to external tools (databases, APIs, cloud services) — [▶ MCP with Azure and GitHub](https://tech.hub.ms/github-copilot/videos/mcp-with-azure-and-github)",
                "Explore [GitHub integrations](https://code.visualstudio.com/docs/copilot/agents/agent-tools) and advanced tools like editFiles and run_in_terminal",
              ],
            },
            {
              stage: 3,
              label: "Stage 3: Copilot Collaborator",
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
              label: "Stage 4: Copilot Strategist",
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
              label: "Stage 1: Copilot Skeptic",
              description: "Using default Copilot without customization",
              thresholds: [
                "No repositories with custom instructions or agents.md",
                "Using fewer than 3 different models",
              ],
              tips: [
                "Create a [.github/copilot-instructions.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) file with project-specific guidelines — [▶ User Instructions video](https://tech.hub.ms/github-copilot/videos/user-instructions)",
                "Start customizing Copilot for your workflow",
              ],
            },
            {
              stage: 2,
              label: "Stage 2: Copilot Explorer",
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
              label: "Stage 3: Copilot Collaborator",
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
              label: "Stage 4: Copilot Strategist",
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
              label: "Stage 1: Copilot Skeptic",
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
              label: "Stage 2: Copilot Explorer",
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
              label: "Stage 3: Copilot Collaborator",
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
              label: "Stage 4: Copilot Strategist",
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
    planModeCount: number; customAgentModeCount: number;
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
      1: "Stage 1: Copilot Skeptic",
      2: "Stage 2: Copilot Explorer",
      3: "Stage 3: Copilot Collaborator",
      4: "Stage 4: Copilot Strategist",
    };

    const totalInteractions = fd.askModeCount + fd.editModeCount + fd.agentModeCount;
    const avgTurnsPerSession = fd.turnsPerSessionCount > 0 ? fd.turnsPerSessionSum / fd.turnsPerSessionCount : 0;
    const switchingFrequency = fd.switchingFreqCount > 0 ? fd.switchingFreqSum / fd.switchingFreqCount : 0;
    const hasModelSwitching = fd.mixedTierSessions > 0 || switchingFrequency > 0;
    const hasAgentMode = fd.agentModeCount > 0;
    const toolCount = Object.keys(fd.toolCallsByTool).length;
    const avgFilesPerSession = fd.filesPerEditCount > 0 ? fd.filesPerEditSum / fd.filesPerEditCount : 0;
    const avgApplyRate = fd.applyRateCount > 0 ? fd.applyRateSum / fd.applyRateCount : 0;
    const totalContextRefs = fd.ctxFile + fd.ctxSelection + fd.ctxSymbol + fd.ctxCodebase + fd.ctxWorkspace;

    // 1. Prompt Engineering
    let peStage = 1;
    const slashCmds = ["explain", "fix", "tests", "doc", "generate", "optimize", "new", "newNotebook", "search", "fixTestFailure", "setupTests"];
    const usedSlashCommands = slashCmds.filter(cmd => (fd.toolCallsByTool[cmd] ?? 0) > 0);
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
    if (fd.agentModeCount >= 10 && toolCount >= 3) { agStage = Math.max(agStage, 3); }
    if (fd.agentModeCount >= 50 && toolCount >= 5) { agStage = 4; }
    if (fd.multiFileEdits >= 20 && avgFilesPerSession >= 3) { agStage = Math.max(agStage, 4); }
    const agTips: string[] = [];
    if (agStage < 2) { agTips.push("Try agent mode — it can run terminal commands, edit files, and explore codebases autonomously"); }
    if (agStage < 3) { agTips.push("Use agent mode for multi-step tasks; let it chain tools like file search, terminal, and code edits"); }
    if (agStage < 4) { agTips.push("Tackle complex refactoring or debugging tasks in agent mode for deeper autonomous workflows"); }

    // 4. Tool Usage
    let tuStage = 1;
    if (toolCount > 0) { tuStage = 2; }
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
    if (cuStage < 2) { cuTips.push("Create a .github/copilot-instructions.md file with project-specific guidelines"); }
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
		1: 'Stage 1: Copilot Skeptic',
		2: 'Stage 2: Copilot Explorer',
		3: 'Stage 3: Copilot Collaborator',
		4: 'Stage 4: Copilot Strategist'
	};

	// ---------- 1. Prompt Engineering ----------
	const peEvidence: string[] = [];
	const peTips: string[] = [];
	let peStage = 1;

	const totalInteractions = p.modeUsage.ask + p.modeUsage.edit + p.modeUsage.agent;
	if (totalInteractions > 0) {
		peEvidence.push(`${fmt(totalInteractions)} total interactions`);
	}
	if (p.modeUsage.ask > 0) {
		peEvidence.push(`${fmt(p.modeUsage.ask)} ask-mode conversations`);
	}
	if (p.modeUsage.agent > 0) {
		peEvidence.push(`${fmt(p.modeUsage.agent)} agent-mode interactions`);
	}

	// Conversation patterns (multi-turn shows iterative refinement)
	if (p.conversationPatterns) {
		const multiTurnRate = p.sessions > 0
			? Math.round((p.conversationPatterns.multiTurnSessions / p.sessions) * 100)
			: 0;
		if (p.conversationPatterns.multiTurnSessions > 0) {
			peEvidence.push(`${fmt(p.conversationPatterns.multiTurnSessions)} multi-turn sessions (${multiTurnRate}%)`);
		}
		if (p.conversationPatterns.avgTurnsPerSession >= 3) {
			peEvidence.push(`Avg ${p.conversationPatterns.avgTurnsPerSession.toFixed(1)} exchanges per session`);
			peStage = Math.max(peStage, 2) as 1 | 2 | 3 | 4;
		}
		if (p.conversationPatterns.avgTurnsPerSession >= 5) {
			peStage = Math.max(peStage, 3) as 1 | 2 | 3 | 4;
		}
	}

	if (totalInteractions >= 5) {
		peStage = 2; // At least trying it out
	}

	// Check slash command / tool usage (indicates structured prompts)
	const slashCommands = ['explain', 'fix', 'tests', 'doc', 'generate', 'optimize', 'new', 'newNotebook', 'search', 'fixTestFailure', 'setupTests'];
	const usedSlashCommands = slashCommands.filter(cmd => (p.toolCalls.byTool[cmd] || 0) > 0);
	if (usedSlashCommands.length > 0) {
		peEvidence.push(`Used slash commands: /${usedSlashCommands.join(', /')}`);
	}

	const hasModelSwitching = p.modelSwitching.mixedTierSessions > 0 || p.modelSwitching.switchingFrequency > 0;
	const hasAgentMode = p.modeUsage.agent > 0;

	if (totalInteractions >= 30 && (usedSlashCommands.length >= 2 || hasAgentMode)) {
		peStage = 3; // Regular, purposeful use
	}

	// Strategist: high volume + agent mode + (model switching or diverse slash commands)
	if (totalInteractions >= 100 && hasAgentMode && (hasModelSwitching || usedSlashCommands.length >= 3)) {
		peStage = 4;
	}

	// Model switching awareness
	if (hasModelSwitching) {
		peEvidence.push(`Switched models in ${Math.round(p.modelSwitching.switchingFrequency)}% of sessions`);
		if (peStage < 4 && p.modelSwitching.mixedTierSessions > 0) {
			peStage = Math.max(peStage, 3) as 1 | 2 | 3 | 4;
		}
	}

	// Context-aware tips
	if (peStage < 2) { peTips.push('Try asking Copilot a question using the Chat panel'); }
	if (peStage < 3) {
		if (!hasAgentMode) { peTips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for multi-file changes'); }
		if (usedSlashCommands.length < 2) { peTips.push('Use [slash commands](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like /explain, /fix, or /tests to give structured prompts'); }
	}
	if (peStage < 4) {
		if (!hasAgentMode) { peTips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for autonomous, multi-step coding tasks'); }
		if (!hasModelSwitching) { peTips.push('Experiment with [different models](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_choose-a-language-model) for different tasks - use fast models for simple queries and reasoning models for complex problems'); }
		if (usedSlashCommands.length < 3 && hasAgentMode && hasModelSwitching) { peTips.push('Explore more [slash commands](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like /explain, /tests, or /doc to diversify your prompting'); }
	}

	// ---------- 2. Context Engineering ----------
	const ceEvidence: string[] = [];
	const ceTips: string[] = [];
	let ceStage = 1;

	const totalContextRefs = p.contextReferences.file + p.contextReferences.selection +
		p.contextReferences.symbol + p.contextReferences.codebase + p.contextReferences.workspace;
	const refTypes = [
		p.contextReferences.file > 0,
		p.contextReferences.selection > 0,
		p.contextReferences.symbol > 0,
		p.contextReferences.codebase > 0,
		p.contextReferences.workspace > 0,
		p.contextReferences.terminal > 0,
		p.contextReferences.vscode > 0,
		p.contextReferences.clipboard > 0,
		p.contextReferences.changes > 0,
		p.contextReferences.problemsPanel > 0,
		p.contextReferences.outputPanel > 0,
		p.contextReferences.terminalLastCommand > 0,
		p.contextReferences.terminalSelection > 0
	];
	const usedRefTypeCount = refTypes.filter(Boolean).length;

	if (p.contextReferences.file > 0) { ceEvidence.push(`${fmt(p.contextReferences.file)} #file references`); }
	if (p.contextReferences.selection > 0) { ceEvidence.push(`${fmt(p.contextReferences.selection)} #selection references`); }
	if (p.contextReferences.codebase > 0) { ceEvidence.push(`${fmt(p.contextReferences.codebase)} #codebase references`); }
	if (p.contextReferences.workspace > 0) { ceEvidence.push(`${fmt(p.contextReferences.workspace)} @workspace references`); }
	if (p.contextReferences.terminal > 0) { ceEvidence.push(`${fmt(p.contextReferences.terminal)} @terminal references`); }
	if (p.contextReferences.vscode > 0) { ceEvidence.push(`${fmt(p.contextReferences.vscode)} @vscode references`); }
	if (p.contextReferences.clipboard > 0) { ceEvidence.push(`${fmt(p.contextReferences.clipboard)} #clipboard references`); }
	if (p.contextReferences.changes > 0) { ceEvidence.push(`${fmt(p.contextReferences.changes)} #changes references`); }
	if (p.contextReferences.problemsPanel > 0) { ceEvidence.push(`${fmt(p.contextReferences.problemsPanel)} #problemsPanel references`); }
	if (p.contextReferences.outputPanel > 0) { ceEvidence.push(`${fmt(p.contextReferences.outputPanel)} #outputPanel references`); }
	if (p.contextReferences.terminalLastCommand > 0) { ceEvidence.push(`${fmt(p.contextReferences.terminalLastCommand)} #terminalLastCommand references`); }
	if (p.contextReferences.terminalSelection > 0) { ceEvidence.push(`${fmt(p.contextReferences.terminalSelection)} #terminalSelection references`); }

	if (totalContextRefs >= 1) { ceStage = 2; }
	if (usedRefTypeCount >= 3 && totalContextRefs >= 10) { ceStage = 3; }
	if (usedRefTypeCount >= 5 && totalContextRefs >= 30) { ceStage = 4; }

	// Image context (byKind: copilot.image)
	const imageRefs = p.contextReferences.byKind['copilot.image'] || 0;
	if (imageRefs > 0) {
		ceEvidence.push(`${fmt(imageRefs)} image references (vision)`);
		ceStage = Math.max(ceStage, 3) as 1 | 2 | 3 | 4;
	}

	if (ceStage < 2) { ceTips.push('Try adding [#file or #selection](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) references to give Copilot more context'); }
	if (ceStage < 3) { ceTips.push('Explore [@workspace, #codebase, and @terminal](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) for broader context'); }
	if (ceStage < 4) {
		const typesStillNeeded = Math.max(0, 5 - usedRefTypeCount);
		const refsStillNeeded = Math.max(0, 30 - totalContextRefs);
		const specializedItems = [
			{ name: 'image attachments', used: imageRefs > 0 },
			{ name: '#changes', used: p.contextReferences.changes > 0 },
			{ name: '#problemsPanel', used: p.contextReferences.problemsPanel > 0 },
			{ name: '#outputPanel', used: p.contextReferences.outputPanel > 0 },
			{ name: '#terminalLastCommand', used: p.contextReferences.terminalLastCommand > 0 },
			{ name: '#terminalSelection', used: p.contextReferences.terminalSelection > 0 },
			{ name: '#clipboard', used: p.contextReferences.clipboard > 0 },
			{ name: '@vscode', used: p.contextReferences.vscode > 0 },
		];
		const specializedUsedCount = specializedItems.filter(i => i.used).length;
		if (specializedUsedCount >= 2) {
			// User already uses multiple specialized context techniques — show a concrete gap tip.
			const allTypesNotUsed = [
				{ name: '#symbol', used: p.contextReferences.symbol > 0 },
				{ name: '@workspace', used: p.contextReferences.workspace > 0 },
				{ name: '#codebase', used: p.contextReferences.codebase > 0 },
				{ name: '@terminal', used: p.contextReferences.terminal > 0 },
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
				ceTips.push(`Try ${toMention.join(', ')}${extra} — see [specialized context variables](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) to reach Stage 4`);
			}
		}
	}

	// ---------- 3. Agentic ----------
	const agEvidence: string[] = [];
	const agTips: string[] = [];
	let agStage = 1;

	if (p.modeUsage.agent > 0) {
		agEvidence.push(`${fmt(p.modeUsage.agent)} agent-mode interactions`);
		agStage = 2;
	}
	if (p.toolCalls.total > 0) {
		agEvidence.push(`${fmt(p.toolCalls.total)} tool calls executed`);
	}
	if (p.modeUsage.edit > 0) {
		agEvidence.push(`${fmt(p.modeUsage.edit)} edit-mode interactions`);
	}

	// Edit scope tracking (multi-file edits show advanced agentic behavior)
	if (p.editScope) {
		const multiFileRate = p.editScope.totalEditedFiles > 0
			? Math.round((p.editScope.multiFileEdits / (p.editScope.singleFileEdits + p.editScope.multiFileEdits)) * 100)
			: 0;
		if (p.editScope.multiFileEdits > 0) {
			agEvidence.push(`${fmt(p.editScope.multiFileEdits)} multi-file edit sessions (${multiFileRate}%)`);
			agStage = Math.max(agStage, 2) as 1 | 2 | 3 | 4;
		}
		if (p.editScope.avgFilesPerSession >= 3) {
			agEvidence.push(`Avg ${p.editScope.avgFilesPerSession.toFixed(1)} files per edit session`);
			agStage = Math.max(agStage, 3) as 1 | 2 | 3 | 4;
		}
	}

	// Agent type distribution
	if (p.agentTypes && p.agentTypes.editsAgent > 0) {
		agEvidence.push(`${fmt(p.agentTypes.editsAgent)} edits agent sessions`);
		agStage = Math.max(agStage, 2) as 1 | 2 | 3 | 4;
	}

	// Diverse tool usage in agent mode
	const toolCount = Object.keys(p.toolCalls.byTool).length;
	if (p.modeUsage.agent >= 10 && toolCount >= 3) {
		agStage = 3;
	}

	// Heavy agentic use with many tool types or high multi-file edit rate
	if (p.modeUsage.agent >= 50 && toolCount >= 5) {
		agStage = 4;
	}
	if (p.editScope && p.editScope.multiFileEdits >= 20 && p.editScope.avgFilesPerSession >= 3) {
		agStage = Math.max(agStage, 4) as 1 | 2 | 3 | 4;
	}

	if (agStage < 2) { agTips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) — it can run terminal commands, edit files, and explore your codebase autonomously'); }
	if (agStage < 3) { agTips.push('Use [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for multi-step tasks; let it chain tools like file search, terminal, and code edits'); }
	if (agStage < 4) { agTips.push('Tackle complex refactoring or debugging tasks in [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) for deeper autonomous workflows'); }

	// ---------- 4. Tool Usage ----------
	const tuEvidence: string[] = [];
	const tuTips: string[] = [];
	let tuStage = 1;

	// Basic tool usage (primarily from agent mode)
	if (toolCount > 0) {
		tuEvidence.push(`${fmt(toolCount)} unique tools used`);
		tuStage = 2;
	}

	// Agent type distribution (workspace agent shows advanced tool usage)
	if (p.agentTypes) {
		if (p.agentTypes.workspaceAgent > 0) {
			tuEvidence.push(`${fmt(p.agentTypes.workspaceAgent)} @workspace agent sessions`);
			tuStage = Math.max(tuStage, 3) as 1 | 2 | 3 | 4;
		}
	}

	// Specific advanced tool IDs (intentional tool integration)
	const advancedToolFriendlyNames: Record<string, string> = {
		github_pull_request: 'GitHub Pull Request',
		github_repo: 'GitHub Repository',
		run_in_terminal: 'Run In Terminal',
		editFiles: 'Edit Files',
		listFiles: 'List Files'
	};
	const usedAdvanced = Object.keys(advancedToolFriendlyNames).filter(t => (p.toolCalls.byTool[t] || 0) > 0);
	if (usedAdvanced.length > 0) {
		tuEvidence.push(`Advanced tools: ${usedAdvanced.map(t => advancedToolFriendlyNames[t]).join(', ')}`);
		if (usedAdvanced.length >= 2) {
			tuStage = Math.max(tuStage, 3) as 1 | 2 | 3 | 4;
		}
	}

	// MCP tools are a strong signal of strategic/advanced use
	const mcpServers = Object.keys(p.mcpTools.byServer);
	if (p.mcpTools.total > 0) {
		tuEvidence.push(`${fmt(p.mcpTools.total)} MCP tool calls across ${mcpServers.length} server(s)`);
		tuStage = Math.max(tuStage, 3) as 1 | 2 | 3 | 4; // Using any MCP server is stage 3
		if (mcpServers.length >= 2) {
			tuStage = 4; // Multiple MCP servers = strategist
		}
	}

	// Tips based on current state
	if (tuStage < 2) {
		tuTips.push('Try [agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) to let Copilot use built-in tools for file operations and terminal commands');
	}
	if (tuStage < 3) {
		if (mcpServers.length === 0) {
			tuTips.push('Set up [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to connect Copilot to external tools (databases, APIs, cloud services)');
		} else {
			tuTips.push('Explore [GitHub integrations](https://code.visualstudio.com/docs/copilot/agents/agent-tools) and advanced tools like editFiles and run_in_terminal');
		}
	}
	if (tuStage < 4) {
		if (mcpServers.length === 1) {
			tuTips.push('Add more [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) to expand Copilot\'s capabilities - check the VS Code MCP registry');
		} else if (mcpServers.length === 0) {
			tuTips.push('Explore the [VS Code MCP registry](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for tools that integrate with your workflow');
		} else {
			tuTips.push('You\'re using multiple MCP servers - keep exploring advanced tool combinations');
		}
	}

	// ---------- 5. Customization ----------
	const cuEvidence: string[] = [];
	const cuTips: string[] = [];
	let cuStage = 1;

	// Derive repo-level customization from the customization matrix (which is actually populated)
	const matrix = lastCustomizationMatrix;
	const totalRepos = matrix?.totalWorkspaces ?? 0;
	const reposWithCustomization = totalRepos - (matrix?.workspacesWithIssues ?? 0);
	const customizationRate = totalRepos > 0 ? (reposWithCustomization / totalRepos) : 0;

	if (totalRepos > 0) {
		cuEvidence.push(`Worked in ${totalRepos} repositor${totalRepos === 1 ? 'y' : 'ies'}`);
	}

	if (reposWithCustomization > 0) {
		cuStage = 2;
	}

	// Stage thresholds based on adoption rate
	if (customizationRate >= 0.3 && reposWithCustomization >= 2) {
		cuStage = 3;
	}

	if (customizationRate >= 0.7 && reposWithCustomization >= 3) {
		cuStage = 4;
	}

	// Model selection awareness (choosing specific models)
	const uniqueModels = [...new Set([
		...p.modelSwitching.standardModels,
		...p.modelSwitching.premiumModels
	])];
	if (uniqueModels.length >= 3) {
		// Check for Stage 4 criteria first
		const hasStage4Models = uniqueModels.length >= 5 && reposWithCustomization >= 3;
		
		cuEvidence.push(`Used ${uniqueModels.length} different models`);
		if (hasStage4Models) {
			cuStage = 4;
		} else if (uniqueModels.length >= 5) {
			cuStage = Math.max(cuStage, 3) as 1 | 2 | 3 | 4;
		} else {
			cuStage = Math.max(cuStage, 3) as 1 | 2 | 3 | 4;
		}
	}

	// Show repo customization evidence once, reflecting the final achieved stage
	if (cuStage >= 4) {
		cuEvidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos customized (70%+ with 3+ repos → Stage 4)`);
	} else if (cuStage >= 3) {
		cuEvidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos customized (30%+ with 2+ repos → Stage 3)`);
	} else if (reposWithCustomization > 0) {
		cuEvidence.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos with custom instructions or agents.md`);
	}

	if (cuStage < 2) { cuTips.push('Create a [.github/copilot-instructions.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) file with project-specific guidelines'); }
	if (cuStage < 3) { cuTips.push('Add [custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) to more repositories to standardize your Copilot experience'); }
	if (cuStage < 4) {
		const uncustomized = totalRepos - reposWithCustomization;
		if (totalRepos > 0 && uncustomized > 0) {
			cuTips.push(`${fmt(reposWithCustomization)} of ${fmt(totalRepos)} repos have customization — add [instructions and agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions) to the remaining ${fmt(uncustomized)} repo${uncustomized === 1 ? '' : 's'} for Stage 4`);
		} else {
			cuTips.push('Aim for consistent customization across all projects with [instructions and agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)');
		}
	}
	if (cuStage >= 4) {
		const uncustomized = totalRepos - reposWithCustomization;
		if (uncustomized > 0) {
			const missingCustomizationRepos = (matrix?.workspaces || [])
				.filter(row => Object.values(row.typeStatuses).every(status => status === '❌'));
			const prioritizedMissingRepos = missingCustomizationRepos
				.filter(row => !row.workspacePath.startsWith('<unresolved:'))
				.sort((a, b) => {
					if (b.interactionCount !== a.interactionCount) {
						return b.interactionCount - a.interactionCount;
					}
					return b.sessionCount - a.sessionCount;
				})
				.slice(0, 3);

			const summaryTip = `${fmt(uncustomized)} repo${uncustomized === 1 ? '' : 's'} still missing customization — add [instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), [agents.md](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), or [MCP configs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for full coverage.`;
			if (prioritizedMissingRepos.length > 0) {
				const repoLines = prioritizedMissingRepos.map(row => 
					`${row.workspaceName} (${fmt(row.interactionCount)} interaction${row.interactionCount === 1 ? '' : 's'})`
				).join('\n');
				cuTips.push(`${summaryTip}\n\nTop repos to customize first:\n${repoLines}`);
			} else {
				cuTips.push(summaryTip);
			}
		} else {
			cuTips.push('All repos customized! Keep instructions up to date and add [skill files](https://code.visualstudio.com/docs/copilot/customization/agent-skills) or [MCP server configs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) for deeper integration');
		}
	}

	// ---------- 6. Workflow Integration ----------
	const wiEvidence: string[] = [];
	const wiTips: string[] = [];
	let wiStage = 1;

	// Sessions count reflects regularity
	if (p.sessions >= 3) {
		wiEvidence.push(`${fmt(p.sessions)} sessions in the last 30 days`);
		wiStage = 2;
	}

	// Apply button usage (high rate shows active adoption of suggestions)
	if (p.applyUsage && p.applyUsage.totalCodeBlocks > 0) {
		const applyRatePercent = Math.round(p.applyUsage.applyRate);
		wiEvidence.push(`${applyRatePercent}% code block apply rate (${fmt(p.applyUsage.totalApplies)}/${fmt(p.applyUsage.totalCodeBlocks)})`);
		if (applyRatePercent >= 50) {
			wiStage = Math.max(wiStage, 2) as 1 | 2 | 3 | 4;
		}
	}

	// Session duration (informational only - not used for staging)
	if (p.sessionDuration && p.sessionDuration.avgDurationMs > 0) {
		const avgMinutes = Math.round(p.sessionDuration.avgDurationMs / 60000);
		wiEvidence.push(`Avg ${avgMinutes}min session duration`);
	}

	// Multi-mode usage (ask + agent) - key indicator of integration
	const modesUsed = [p.modeUsage.ask > 0, p.modeUsage.agent > 0].filter(Boolean).length;
	if (modesUsed >= 2) {
		wiEvidence.push(`Uses ${modesUsed} modes (ask/agent)`);
		wiStage = Math.max(wiStage, 3) as 1 | 2 | 3 | 4;
	}

	// Explicit context usage - strong signal of intentional integration
	const hasExplicitContext = totalContextRefs >= 10;
	if (hasExplicitContext) {
		wiEvidence.push(`${fmt(totalContextRefs)} explicit context references`);
		if (totalContextRefs >= 20) {
			wiStage = Math.max(wiStage, 3) as 1 | 2 | 3 | 4;
		}
	}

	// Stage 4: Multi-mode + explicit context + regular usage
	if (p.sessions >= 15 && modesUsed >= 2 && totalContextRefs >= 20) {
		wiStage = 4;
		wiEvidence.push('Deep integration: regular usage with multi-mode and explicit context');
	}

	if (wiStage < 2) { wiTips.push('Use Copilot more regularly - even for quick questions'); }
	if (wiStage < 3) { 
		if (modesUsed < 2) { wiTips.push('Combine [ask mode with agent mode](https://code.visualstudio.com/docs/copilot/agents/overview) in your daily workflow'); }
		if (totalContextRefs < 10) { wiTips.push('Use explicit [context references](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) like #file, @workspace, and #selection'); }
	}
	if (wiStage < 4) { 
		if (totalContextRefs < 20) { wiTips.push('Make explicit context a habit - use [#file, @workspace, and other references](https://code.visualstudio.com/docs/copilot/chat/copilot-chat#_add-context-to-your-prompts) consistently'); }
		wiTips.push('Make Copilot part of every coding task: planning, coding, testing, and reviewing'); 
	}

	// ---------- Overall score (median) ----------
	const scores = [peStage, ceStage, agStage, tuStage, cuStage, wiStage].sort((a, b) => a - b);
	const mid = Math.floor(scores.length / 2);
	const overallStage = scores.length % 2 === 0
		? Math.round((scores[mid - 1] + scores[mid]) / 2)
		: scores[mid];

	return {
		overallStage,
		overallLabel: stageLabels[overallStage] || `Stage ${overallStage}`,
		categories: [
			{ category: 'Prompt Engineering', icon: '💬', stage: peStage, evidence: peEvidence, tips: peTips },
			{ category: 'Context Engineering', icon: '📎', stage: ceStage, evidence: ceEvidence, tips: ceTips },
			{ category: 'Agentic', icon: '🤖', stage: agStage, evidence: agEvidence, tips: agTips },
			{ category: 'Tool Usage', icon: '🔧', stage: tuStage, evidence: tuEvidence, tips: tuTips },
			{ category: 'Customization', icon: '⚙️', stage: cuStage, evidence: cuEvidence, tips: cuTips },
			{ category: 'Workflow Integration', icon: '🔄', stage: wiStage, evidence: wiEvidence, tips: wiTips }
		],
		period: p,
		lastUpdated: stats.lastUpdated.toISOString()
	};
}
