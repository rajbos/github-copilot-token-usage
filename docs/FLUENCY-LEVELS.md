# Copilot Fluency Score — Scoring Rules

The Copilot Fluency Score maps your GitHub Copilot usage patterns from the **last 30 days** into a maturity model with **4 stages** across **6 categories**. The overall fluency stage is the **median** of the 6 category scores.

## Stages

| Stage | Label | Description |
|-------|-------|-------------|
| 1 | **Copilot Skeptic** | Rarely uses Copilot or uses only basic features |
| 2 | **Copilot Explorer** | Exploring Copilot capabilities with occasional use |
| 3 | **Copilot Collaborator** | Regular, purposeful use across multiple features |
| 4 | **Copilot Strategist** | Strategic, advanced use leveraging the full Copilot ecosystem |

---

## Categories

### 1. 💬 Prompt Engineering

Measures how you interact with Copilot through prompts, slash commands, and mode diversity.

| Stage | Criteria |
|-------|----------|
| 1 | Fewer than 5 total interactions |
| 2 | At least 5 total interactions (ask + edit + agent) |
| 3 | 30+ interactions **and** (2+ slash commands used **or** agent mode used) |
| 4 | 100+ interactions **and** agent mode used **and** (model switching **or** 3+ slash commands) |

**Boosters** (can raise the stage independently):
- Average 3+ exchanges per session → at least Stage 2
- Average 5+ exchanges per session → at least Stage 3
- Model switching across tiers → at least Stage 3

**Recognised slash commands:** `/explain`, `/fix`, `/tests`, `/doc`, `/generate`, `/optimize`, `/new`, `/newNotebook`, `/search`, `/fixTestFailure`, `/setupTests`

---

### 2. 📎 Context Engineering

Measures how you provide context to Copilot using explicit references.

| Stage | Criteria |
|-------|----------|
| 1 | No context references used |
| 2 | At least 1 context reference |
| 3 | 3+ different reference types **and** 10+ total references |
| 4 | 5+ different reference types **and** 30+ total references |

**Tracked reference types:** `#file`, `#selection`, `#symbol`, `#codebase`, `@workspace`, `@terminal`, `@vscode`, `#clipboard`, `#changes`, `#problemsPanel`, `#outputPanel`, `#terminalLastCommand`, `#terminalSelection`

**Evidence:** All tracked reference types are shown in the evidence panel when used (not just the basic ones).

**Booster:** Using image references (`copilot.image`) → at least Stage 3

**Stage 3 hint behaviour:** The "try specialized context variables" tip is dynamic — it only lists the specific variables the user hasn't tried yet. If the user has already used 2 or more of the specialized set (`image attachments`, `#changes`, `#problemsPanel`, `#outputPanel`, `#terminalLastCommand`, `#terminalSelection`, `#clipboard`, `@vscode`), the hint is suppressed entirely.

---

### 3. 🤖 Agentic

Measures adoption of autonomous, multi-step agent mode workflows.

| Stage | Criteria |
|-------|----------|
| 1 | No agent-mode interactions |
| 2 | At least 1 agent-mode interaction |
| 3 | 10+ agent-mode interactions **and** 3+ unique intentional tools used |
| 4 | 50+ agent-mode interactions **and** 5+ unique intentional tools used |

**Boosters:**
- Multi-file edit sessions detected → at least Stage 2
- Average 3+ files per edit session → at least Stage 3
- 20+ multi-file edits with average 3+ files per session → Stage 4

> **Note:** Only *intentional* tools count toward the unique tool thresholds — tools that Copilot calls automatically (file reads, searches, error lookups, confirmations, memory, etc.) are excluded. See [Automatic vs. Intentional Tools](#automatic-vs-intentional-tools) below.

---

### 4. 🔧 Tool Usage

Measures breadth and depth of tool integration, including MCP servers.

| Stage | Criteria |
|-------|----------|
| 1 | No intentional tools used |
| 2 | At least 1 intentional tool used |
| 3 | 2+ advanced tools used, **or** `@workspace` agent sessions detected, **or** any MCP server usage |
| 4 | 2+ MCP servers used |

**Recognised advanced tools:** GitHub Pull Request, GitHub Repository, Run In Terminal, Edit Files, List Files

> **Note:** Only *intentional* tools count toward Stage 2. Automatic tools are still shown in the tool-usage table with an `auto` badge, but are not counted for scoring. See [Automatic vs. Intentional Tools](#automatic-vs-intentional-tools) below.

---

### Automatic vs. Intentional Tools

Copilot calls many tools on its own during agentic sessions to gather context — reading files, searching the codebase, checking errors, etc. These are called **automatic tools** and do **not** count toward fluency scoring because they do not reflect deliberate configuration choices by the user.

**Automatic tools** (excluded from fluency scoring):
- File operations: `read_file`, `list_dir`, `ls`, `view`, `find_files`, `glob`, `grep`, `grep_search`, `file_search`, `file_glob_search`
- Codebase search: `semantic_search`, `code_search`, `search_workspace_symbols`, `get_symbols_by_name`
- Project info: `get_errors`, `get_changed_files`, `read_project_structure`, `get_project_setup_info`, `get_vscode_api`, `get_doc_info`
- Terminal reads: `terminal_selection`, `terminal_last_command`, `get_terminal_output`, `await_terminal`
- Internal/session: `memory`, `detect_memories`, `tool_replay`, `vscode_get_confirmation*`, `ask_questions`, `switch_agent`, `bash`

**Intentional tools** (count toward fluency scoring) include:
- Terminal execution: `run_in_terminal`, `run_build`, `run_task`
- File writing/editing: `edit_files`, `write_file`, `create_file`, `apply_patch`, `insert_edit_into_file`, `replace_string_in_file`
- Tests and runs: `runTests`, `run_notebook_cell`, `run_vscode_command`, `create_and_run_task`
- External integrations: `fetch_webpage`, `webfetch`, `websearch`, MCP tools (all)
- GitHub: `github_pull_request`, `github_repo`
- Browser: `open_integrated_browser`, `renderMermaidDiagram`
- Extensions and packages: `install_extension`, `install_python_packages`

The full list of automatic tool IDs is maintained in `vscode-extension/src/automaticTools.json`.

### 5. ⚙️ Customization

Measures how you tailor Copilot to your projects (custom instructions, model selection).

| Stage | Criteria |
|-------|----------|
| 1 | No repositories with customization (e.g. `.github/copilot-instructions.md`) |
| 2 | At least 1 repository with customization |
| 3 | 30%+ of repositories customized (minimum 2 repos) |
| 4 | 70%+ of repositories customized (minimum 3 repos) |

**Booster:** Using 3+ different models → at least Stage 3; using 5+ models with 3+ customized repos → Stage 4

---

### 6. 🔄 Workflow Integration

Measures how deeply Copilot is woven into your daily coding workflow.

| Stage | Criteria |
|-------|----------|
| 1 | Fewer than 3 sessions in the last 30 days |
| 2 | 3+ sessions |
| 3 | Using multiple modes (ask + agent) **or** 20+ explicit context references |
| 4 | 15+ sessions **and** multi-mode usage **and** 20+ context references |

**Booster:** 50%+ code-block apply rate → at least Stage 2

---

## Overall Score Calculation

The overall fluency stage is the **median** of the 6 category scores:

1. Sort all 6 category scores
2. Take the average of the two middle values (since 6 is even)
3. Round to the nearest integer

For example, if your category scores are `[1, 2, 3, 3, 4, 4]`, the two middle values are `3` and `3`, so the overall stage is **3 (Copilot Collaborator)**.

## Data Source

Scores are calculated from Copilot Chat session log files stored locally on your machine. Some Copilot features (e.g., inline suggestion acceptance rates) are not captured in these logs and therefore not reflected in the score.

The dashboard updates every 5 minutes automatically. You can also refresh manually from the Fluency Score panel.
