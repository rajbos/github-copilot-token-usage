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
| 3 | 10+ agent-mode interactions **and** 3+ unique tools used |
| 4 | 50+ agent-mode interactions **and** 5+ unique tools used |

**Boosters:**
- Multi-file edit sessions detected → at least Stage 2
- Average 3+ files per edit session → at least Stage 3
- 20+ multi-file edits with average 3+ files per session → Stage 4

---

### 4. 🔧 Tool Usage

Measures breadth and depth of tool integration, including MCP servers.

| Stage | Criteria |
|-------|----------|
| 1 | No tools used |
| 2 | At least 1 unique tool used |
| 3 | 2+ advanced tools used, **or** `@workspace` agent sessions detected, **or** any MCP server usage |
| 4 | 2+ MCP servers used |

**Recognised advanced tools:** GitHub Pull Request, GitHub Repository, Run In Terminal, Edit Files, List Files

---

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
