---
title: User Testing Guide
description: Beta testing guide for backend configuration UI improvements
lastUpdated: 2026-01-26
version: 1.0
status: ready-for-testing
project: ui-improvement
---

# User Testing Guide: Backend Configuration

**Version:** 1.0  
**Date:** 2026-01-23  
**Purpose:** Validate backend configuration UI improvements with real users

## Overview

This guide provides test scenarios, expected behaviors, and feedback collection templates for beta testing the backend configuration panel UI improvements. Focus areas: clarity, progressive disclosure, privacy understanding, and overall user experience.

## Test Participant Profile

**Ideal participants:**
- VS Code users familiar with GitHub Copilot
- Mix of individual users and team leads
- Range of technical expertise (developers to engineering managers)
- 5-10 participants total

**Recruitment criteria:**
- Currently using GitHub Copilot in VS Code
- Interested in tracking token usage (bonus: already using the extension)
- Willing to provide 30-45 minutes of feedback

## Pre-Test Setup

### 1. Environment Preparation

**For testers:**
1. Install latest version of the extension (with Phase 3 improvements)
2. Ensure GitHub Copilot is installed and active
3. Optional: Create a test Azure subscription for full workflow testing

**For facilitators:**
1. Prepare screen sharing session (Zoom, Teams, etc.)
2. Have diagnostic report tool ready
3. Prepare feedback collection form (see Templates section)

### 2. Baseline Context

**Ask before starting:**
- Have you used cloud storage backends before? (Azure, AWS, GCP)
- Are you familiar with privacy concepts like anonymization?
- Do you work on a team that might share usage analytics?
- Have you configured Azure resources before?

## Test Scenarios

### Scenario 1: First-Time Solo User Setup

**Goal:** Validate that a new user can configure solo cloud backup without confusion

**Setup:**
1. Fresh install (no prior backend config)
2. User wants to sync usage across their personal devices

**Steps:**
1. Open Command Palette → "Copilot Token Tracker: Configure Backend"
2. Navigate through Overview, Sharing, Azure sections
3. Choose "Solo" privacy profile
4. Use guided wizard to provision Azure resources (or enter existing)
5. Save & Apply

**Success Criteria:**
- [ ] User understands what "Solo" profile means
- [ ] User knows their data is private (not shared with team)
- [ ] User successfully completes wizard without external documentation
- [ ] User understands what "Save & Apply" will do before clicking
- [ ] User receives clear confirmation after saving

**Observation Points:**
- Does user understand the privacy profile quick reference?
- Does user expand "What do these profiles mean?" details?
- Does user understand placeholder examples in input fields?
- Does user know what lookback days means (7/30/90)?
- Does user understand offline banner if testing offline?

**Expected Time:** 5-10 minutes

---

### Scenario 2: Team Lead Setting Up Shared Analytics

**Goal:** Validate that team leads understand privacy implications and can set up team sharing

**Setup:**
1. User is team lead setting up shared storage account
2. Want team members to sync to same dataset for aggregation

**Steps:**
1. Open Configure Backend panel
2. Navigate to Sharing section
3. Read privacy profile descriptions
4. Choose "Team Anonymized" profile
5. Configure Azure resources (existing shared storage account)
6. Enable "Store readable workspace & machine names" checkbox
7. Review consent dialog when upgrading privacy
8. Save & Apply

**Success Criteria:**
- [ ] User understands difference between Anonymized/Pseudonymous/Identified
- [ ] User understands "Who can see" for each profile (from details table)
- [ ] User understands consent dialog clearly explains privacy change
- [ ] User knows enabling workspace names makes data less private
- [ ] User successfully saves without confusion

**Observation Points:**
- Does user open progressive disclosure details table?
- Does user understand "hashed IDs" concept?
- Does user understand consent reasons clearly?
- Does user know team members with storage access can see data?
- Does user understand "machine breakdown" toggle?

**Expected Time:** 10-15 minutes

---

### Scenario 3: Updating Existing Configuration

**Goal:** Validate that existing users can modify settings without breaking anything

**Setup:**
1. Backend already enabled with "Solo" profile
2. User wants to upgrade to "Team Pseudonymous" for team sharing
3. User needs to add team alias

**Steps:**
1. Open Configure Backend panel
2. Change sharing profile from "Solo" to "Team Pseudonymous"
3. Notice Identity card appears
4. Enter team alias (e.g., "alex-dev")
5. Review & Apply, accept consent
6. Save

**Success Criteria:**
- [ ] User understands they're upgrading privacy permissions
- [ ] User knows what "stable alias" means
- [ ] User understands team alias should NOT be their real name
- [ ] User sees and understands consent dialog
- [ ] User successfully saves updated config

**Observation Points:**
- Does user understand Identity card only shows for Team Identified?
- Does user understand placeholder example "alex-dev"?
- Does user try to enter email address (should be rejected)?
- Does user understand "Team members with storage access can see" warning?
- Does validation message guide user if they enter invalid alias?

**Expected Time:** 5-8 minutes

---

### Scenario 4: Testing Connection & Troubleshooting

**Goal:** Validate error messages and test connection feedback are helpful

**Setup:**
1. User has entered Azure resource IDs manually (not wizard)
2. User wants to verify connection before saving

**Steps:**
1. Fill in Azure resource fields with test values
2. Choose "Entra ID" auth mode
3. Click "Test Connection"
4. Observe result (success or error)
5. If error, user should understand what went wrong

**Success Criteria:**
- [ ] User understands test connection button purpose
- [ ] User sees clear success message with ✓ icon
- [ ] If error, user sees clear error with ✗ icon and reason
- [ ] User knows what to do next after error (suggestion provided)
- [ ] User understands offline banner disables test connection

**Observation Points:**
- Does user understand auth mode difference (Entra ID vs Shared Key)?
- Does user understand test connection is disabled when offline?
- Does error message provide actionable recovery steps?
- Does user know where to find diagnostic info if needed?

**Expected Time:** 3-5 minutes

---

### Scenario 5: Accessibility Testing (Screen Reader)

**Goal:** Validate keyboard navigation and screen reader experience

**Setup:**
1. User relies on screen reader (Windows Narrator, NVDA, JAWS)
2. User navigates configurator using keyboard only

**Steps:**
1. Open Configure Backend panel
2. Tab through navigation buttons
3. Navigate to each section
4. Fill in form fields using keyboard
5. Expand progressive disclosure details
6. Save & Apply

**Success Criteria:**
- [ ] Screen reader announces all sections correctly
- [ ] Form labels read before inputs
- [ ] Helper text read after inputs
- [ ] Error messages announced when validation fails
- [ ] Button purposes clear from ARIA labels
- [ ] Progressive disclosure expand/collapse announced

**Observation Points:**
- Is tab order logical?
- Are all interactive elements reachable via keyboard?
- Do dropdowns work with arrow keys?
- Are validation errors announced immediately?
- Is focus indicator visible on all elements?

**Expected Time:** 10-15 minutes

---

## Feedback Collection

### During Testing: Think-Aloud Protocol

**Ask participants to verbalize:**
- What are you trying to do?
- What do you expect to happen when you click this?
- What does this label/message mean to you?
- Is anything confusing or unclear?
- Would you expect more information here?

**Facilitator notes:**
- Where do they pause or hesitate?
- What do they read vs. skip?
- Do they expand progressive disclosure details?
- Do they reference placeholders or helper text?

### Post-Test Survey

**Rate 1-5 (1=Strongly Disagree, 5=Strongly Agree):**

1. The privacy profiles (Off/Solo/Team) were clearly explained
2. I understood what data would be shared with each profile
3. The input field placeholders were helpful examples
4. Error messages told me how to fix problems
5. The guided wizard made Azure setup easy
6. I felt confident about my privacy choices
7. The interface was easy to navigate
8. The "Save & Apply" action was clear before clicking
9. I would recommend this configurator to a colleague
10. Overall, I'm satisfied with the setup experience

**Open-ended questions:**
- What was the most confusing part of the setup process?
- What did you like most about the configurator?
- What would you change or improve?
- Did you understand the difference between privacy profiles?
- Was any terminology unclear or too technical?
- Did you use the progressive disclosure details? Why or why not?
- Would you feel comfortable setting up team sharing?

### Feedback Template

```markdown
## Participant ID: [P01]
**Date:** [YYYY-MM-DD]
**Duration:** [XX minutes]
**Scenario(s) tested:** [1, 2, 3, etc.]

### Demographics
- Role: [Developer / Team Lead / Manager]
- Azure experience: [None / Beginner / Intermediate / Expert]
- Copilot usage: [X months]

### Quantitative Ratings
Q1: [1-5]  
Q2: [1-5]  
...  
Q10: [1-5]

### Qualitative Feedback
**Most confusing:**  
[User's response]

**Most helpful:**  
[User's response]

**Suggested improvements:**  
[User's response]

### Observations
**Hesitation points:**  
- [Where they paused, re-read, or asked for clarification]

**Errors encountered:**  
- [What went wrong, how they recovered]

**Progressive disclosure usage:**  
- [Did they expand details? Which ones?]

**Privacy understanding:**  
- [Did they understand profile implications?]

### Facilitator Notes
[Any additional context, bugs found, UX issues spotted]

### Action Items
- [ ] [Specific UI improvement needed]
- [ ] [Documentation gap to address]
- [ ] [Bug to file]
```

## Expected Behaviors (Reference)

### Progressive Disclosure

**"What do these profiles mean?" details:**
- Starts collapsed
- Summary text: "What do these profiles mean?"
- Expands to show table with profile comparison
- Table columns: Profile, Who can see, Data includes, User ID stored

### Input Placeholders

| Field | Placeholder | Purpose |
|-------|-------------|---------|
| Dataset ID | `my-team-copilot` | Realistic example |
| Lookback Days | `30` | Common default |
| Subscription ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | GUID format |
| Resource Group | `copilot-tokens-rg` | Naming convention |
| Storage Account | `copilottokenstorage` | Lowercase, no special chars |
| Aggregate Table | `usageAggDaily` | Table naming |
| Events Table | `usageEvents` | Optional table |
| Raw Container | `raw-logs` | Container naming |
| Team Alias | `alex-dev` | Non-identifying handle |

### Validation Messages

**Good examples:**
- "Dataset ID is required. Example: 'my-team-copilot'"
- "Must be between 1 and 90 days"
- "Use letters, numbers, dashes, or underscores"
- "Enter your Entra object ID (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"

**What to avoid:**
- "Required" (too terse)
- "Invalid format" (doesn't explain how to fix)
- "Error" (no context)

## Success Metrics

**Quantitative:**
- Average task completion time within expected ranges
- 90%+ participants complete Scenario 1 without help
- 80%+ participants understand privacy profiles (Q1 avg ≥ 4.0)
- 85%+ participants satisfied overall (Q10 avg ≥ 4.2)

**Qualitative:**
- Zero participants confused about privacy implications
- Progressive disclosure used when needed
- Error messages enable self-recovery
- No critical accessibility barriers

## Iteration Plan

1. **Collect 5-10 user tests** across different scenarios
2. **Analyze patterns** in confusion points, hesitations, errors
3. **Prioritize issues**:
   - P0: Blocks task completion (fix immediately)
   - P1: Causes confusion but recoverable (fix before GA)
   - P2: Nice-to-have improvement (future iteration)
4. **Implement fixes** based on feedback
5. **Re-test** critical changes with 2-3 participants
6. **Document learnings** for future UI work

## Contact & Support

**Test Coordinator:** [Your Name]  
**Issues:** GitHub Issues (tag `user-testing`)  
**Questions:** [Contact method]

---

**Testing Status:** Ready for Beta  
**Version:** 1.0  
**Last Updated:** 2026-01-23
