---
title: UI and Language Improvements
description: Specification for improving UI clarity and user-facing language in backend features
lastUpdated: 2026-01-26
status: complete
---

# UI and Language Improvements for Backend Features

## Overview

This spec outlines improvements to all UI components and user-facing language in the backend features, focusing on clarity, consistency, accessibility, and professional tone.

## Current State Analysis

### UI Components Identified

1. **Backend Config Panel** (`src/backend/configPanel.ts`)
   - Multi-section webview: Overview, Sharing, Azure, Advanced, Review & Apply
   - Heavy use of "helper" text throughout
   - Mix of VS Code Webview UI Toolkit components and custom HTML

2. **Azure Resource Wizard** (`src/backend/services/azureResourceService.ts`)
   - Multi-step QuickPick dialogs
   - Resource selection and creation flows
   - Auth mode selection

3. **Command Messages** (`src/backend/commands.ts`)
   - Success/error notifications
   - Confirmation dialogs
   - Status messages

4. **Validation Messages** (`src/backend/configurationFlow.ts`, `src/backend/identity.ts`)
   - Inline error messages
   - Validation feedback

5. **Status Indicators** (Various)
   - Badges, labels, status lines
   - Connection test results

### Key Issues Identified

#### 1. **Verbose, Over-Explained Content**
- Helper text explicitly labeled "Over-explained guide" is too long
- Multiple paragraphs where one sentence would suffice
- Mixing conceptual explanation with UI guidance

**Example Problem:**
```html
<div class="helper">Over-explained guide: Off keeps every token local-only. Solo syncs to your private dataset (no team access). Team Anonymized hashes workspace/machine IDs and strips names. Team Pseudonymous keeps a stable per-user alias (no names). Team Identified includes an alias or Entra object ID you provide. Moving to more permissive modes prompts for consent.</div>
```

#### 2. **Inconsistent Terminology**
- Mix of technical jargon ("Entra ID", "RBAC", "GUID") and casual language
- Inconsistent capitalization (e.g., "Shared Key" vs "shared key")
- Technical terms introduced without context

**Examples:**
- "Entra ID (RBAC)" - assumes user knows RBAC
- "Storage Shared Key" vs "shared key" vs "Shared key"
- "Dataset ID" vs "dataset" used interchangeably

#### 3. **Unclear Action Outcomes**
- Buttons don't clearly state what happens next
- Consent dialogs use technical language
- Missing "you will" phrasing for actions

**Example:**
```typescript
'This will replace the current shared key with a new one. Make sure the new key is valid.'
```
Should specify: "You'll be prompted to enter the new key..."

#### 4. **Terse Validation Messages**
- "Required" - doesn't say what or why
- "1-90" - assumes user understands this is a range constraint
- Error messages that are technically correct but unhelpful

**Examples:**
```typescript
errors.lookbackDays = '1-90';
errors.datasetId = 'Required';
```

#### 5. **Privacy/Security Language**
- Complex sharing profiles not well explained
- Consent language is heavy-handed
- Privacy implications buried in long paragraphs

#### 6. **Accessibility Concerns**
- Some labels may not work well with screen readers
- Error messages not always associated with inputs
- Status indicators using color alone

#### 7. **Inconsistent Tone**
- Mix of formal ("No Azure subscriptions found for the current identity") and casual ("Add a Shared Key")
- Some messages sound like warnings when they're informational

## Improvement Goals

1. **Clarity** - Every message should be immediately understandable
2. **Brevity** - Say it once, say it clearly, move on
3. **Consistency** - Same terms, same tone, same patterns
4. **Actionability** - Users should know what to do next
5. **Accessibility** - Work well with assistive technologies
6. **Professional** - Maintain VS Code extension quality bar
7. **Privacy-Aware** - Make data handling transparent without overwhelming

## Improvement Categories

### A. Config Panel Content

#### A1. Overview Section
**Current Problems:**
- Over-explains every concept
- Repeats information available elsewhere
- Unclear what "Stay Local" actually means

**Proposed Changes:**
- Reduce helper text by 60%
- Use progressive disclosure pattern
- Add a "Learn more" link instead of walls of text
- Clarify "Stay Local" means "disable backend and keep all data local"

**Before:**
```html
<p class="helper">Everything starts with the toggle: when backend is enabled, new session stats sync to Azure using your chosen sharing profile and auth mode. When you hit Stay Local, sync stops and data never leaves this device.</p>
```

**After:**
```html
<p class="helper">Enable backend to sync token usage to Azure. Choose "Stay Local" to keep all data on this device only.</p>
```

#### A2. Sharing Profile Section
**Current Problems:**
- "Over-explained guide" label is self-deprecating
- Examples buried in long paragraphs
- Technical concepts mixed with UI instructions

**Proposed Changes:**
- Remove "Over-explained" prefix
- Split conceptual help from examples
- Use bulleted lists for clarity
- Add "Privacy Impact" mini-summary for each profile

**Before:**
```html
<div class="helper">Over-explained guide: Off keeps every token local-only. Solo syncs to your private dataset (no team access). Team Anonymized hashes workspace/machine IDs and strips names. Team Pseudonymous keeps a stable per-user alias (no names). Team Identified includes an alias or Entra object ID you provide. Moving to more permissive modes prompts for consent.</div>
```

**After:**
```html
<div class="helper">
  <strong>Off</strong> – All data stays local • 
  <strong>Solo</strong> – Your private cloud storage • 
  <strong>Team Anonymized</strong> – Hashed IDs, no names • 
  <strong>Team Pseudonymous</strong> – Stable alias • 
  <strong>Team Identified</strong> – Full identifier
</div>
<p class="helper-detail">Upgrading to more permissive profiles requires consent.</p>
```

#### A3. Azure Section
**Current Problems:**
- "We use these IDs to know where to write" - awkward phrasing
- Mixed required/optional fields not visually distinct
- Auth mode helper text is too technical

**Proposed Changes:**
- Clearer field labels with required/optional badges
- Simpler auth mode descriptions
- Group required fields visually

**Before:**
```html
<p class="helper">We use these IDs to know where to write rollups and raw logs. If you used the guided wizard, paste the values it produced here.</p>
```

**After:**
```html
<p class="helper">Azure Storage connection details. Use the guided wizard to auto-fill these fields.</p>
```

#### A4. Advanced Section
**Current Problems:**
- "Bounds: 1-90 days" format is unclear
- Examples use parenthetical format hard to scan
- Doesn't explain why 90-day limit exists

**Proposed Changes:**
- Use inline validation feedback
- Clearer examples format
- Brief rationale for limit

**Before:**
```html
<div class="helper">Bounds: 1-90 days. Examples: 7 keeps just this week (fastest sync/queries), 30 keeps a month (balanced), 90 keeps a quarter (largest storage/slower sync). Lower values mean faster runs and fewer rows.</div>
```

**After:**
```html
<label>Lookback days <span class="range">(1-90)</span></label>
<div class="helper">How far back to sync: 7 days = current week, 30 days = current month, 90 days = full quarter. Smaller values sync faster.</div>
```

### B. Validation Messages

#### B1. Error Message Standards

**Current Problems:**
- Too terse
- Don't explain what's wrong or how to fix it
- Inconsistent format

**Proposed Pattern:**
```typescript
// Bad
errors.datasetId = 'Required';

// Good
errors.datasetId = 'Dataset ID is required. Example: "my-team-tokens"';

// Bad
errors.lookbackDays = '1-90';

// Good
errors.lookbackDays = 'Must be between 1 and 90 days';

// Bad  
errors.userId = 'Use an Entra object ID (GUID)';

// Good
errors.userId = 'Enter your Entra object ID (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)';
```

#### B2. Inline Validation

**Add real-time helpful hints:**
- Format examples as placeholder text
- Show character count for limited fields
- Preview the formatted value (e.g., show what hashed ID would look like)

### C. Command Messages

#### C1. Success Messages

**Current Problems:**
- Sometimes too verbose
- Don't indicate next steps
- Mix technical details with confirmation

**Standard Pattern:**
```typescript
// Bad
'Shared key is stored securely for this storage account on this machine.'

// Good
'Shared key saved for [storage-account-name]'

// Bad
'Manual sync completed successfully.'

// Good
'Synced to Azure successfully'
```

#### C2. Error Messages

**Current Problems:**
- Technical error details exposed to user
- No recovery suggestions
- Inconsistent format

**Standard Pattern:**
```typescript
// Bad
showBackendError(`Query failed: ${error instanceof Error ? error.message : String(error)}`);

// Good
showBackendError(
  'Unable to query backend data',
  `Check your connection and auth settings. Details: ${briefErrorSummary(error)}`
);
```

#### C3. Confirmation Dialogs

**Current Problems:**
- Use warning/scary language for routine operations
- Don't clearly state the irreversibility
- Button text not action-oriented

**Standard Pattern:**
```typescript
// Bad
const confirmed = await confirmAction(
  'This will remove the stored shared key from this machine. You will need to re-enter it to sync.',
  'Clear Key'
);

// Good
const confirmed = await vscode.window.showWarningMessage(
  'Remove stored shared key from this device?',
  { modal: true, detail: 'You will need to re-enter the key to sync again.' },
  'Remove Key'
);
```

### D. Wizard Flow

#### D1. Wizard Step Titles

**Make each step's purpose clear:**

**Before:**
```typescript
{ title: 'Select Azure subscription for backend sync' }
```

**After:**
```typescript
{ title: 'Step 1 of 5: Choose Subscription' }
```

#### D2. Wizard Descriptions

**Current Problems:**
- Mix usage guidance with information
- Don't indicate what comes next

**Pattern:**
```typescript
// Bad
{ placeHolder: 'e.g. copilot-token-tracker-rg' }

// Good
{ 
  placeHolder: 'copilot-tokens-rg',
  prompt: 'Enter a name for the new resource group'
}
```

### E. Status Indicators

#### E1. Badges

**Current:**
```typescript
'Backend: Enabled' | 'Backend: Stay Local'
'Auth: Entra ID (RBAC)' | 'Auth: Shared Key stored on this machine'
```

**Proposed:**
```typescript  
'Backend Enabled' | 'Local Only'
'Entra ID Auth' | 'Shared Key Auth'
```

#### E2. Test Connection Results

**Current:**
```html
<div class="status-line ok">Connection succeeded: Able to read/write backend table.</div>
<div class="status-line error">Connection failed: [error message]</div>
```

**Proposed:**
```html
<div class="status-line ok">✓ Connected to Azure Storage successfully</div>
<div class="status-line error">✗ Connection failed: [brief reason]. [action link]</div>
```

### F. Accessibility

#### F1. ARIA Labels

**Add to all interactive elements:**
```html
<vscode-button id="testConnectionBtn" aria-label="Test connection to Azure Storage">
  Test Connection
</vscode-button>
```

#### F2. Error Association

**Ensure errors are programmatically associated:**
```html
<vscode-text-field 
  id="datasetId" 
  aria-describedby="datasetId-help datasetId-error"
  aria-invalid="${hasError ? 'true' : 'false'}">
</vscode-text-field>
<div id="datasetId-help" class="helper">Dataset ID groups your usage data</div>
<div id="datasetId-error" class="error" role="alert" data-error-for="datasetId"></div>
```

#### F3. Status Updates

**Use ARIA live regions:**
```html
<div id="testResult" class="status-line" aria-live="polite" role="status"></div>
```

### G. Terminology Standards

#### G1. Consistent Capitalization

| Term | Standard | Usage |
|------|----------|-------|
| Backend | Capitalized when referring to feature | "Backend is enabled" |
| backend | Lowercase when referring to technical component | "sync to backend store" |
| Shared Key | Capitalized | "Enter your Storage Account Shared Key" |
| Dataset ID | Capitalized | "Dataset ID is required" |
| Entra ID | Always this format | Not "EntraID" or "Entra Id" |

#### G2. Avoid Jargon

| Instead of | Use | Why |
|------------|-----|-----|
| "RBAC" | "role-based access" | RBAC is Azure-specific jargon |
| "GUID" | "unique identifier" or show format | GUID is programmer jargon |
| "rollups" | "usage summaries" | More user-friendly |
| "data plane" | "storage connection" | Internal implementation detail |

#### G3. Action Verbs

Use clear, specific action verbs:
- "Sync" not "push to backend"
- "Remove" not "clear"
- "Update" not "rotate" (for keys)
- "Export" not "copy to clipboard" 

### H. Content Organization

#### H1. Progressive Disclosure

**Group information by user need:**

1. **Getting Started** - Minimum info to make a decision
2. **Details** - Expand for more context
3. **Technical** - Link to docs for deep dive

**Example:**
```html
<!-- Getting Started -->
<label>Sharing Profile</label>
<vscode-dropdown id="sharingProfile">...</vscode-dropdown>

<!-- Details (collapsed by default) -->
<details>
  <summary>What do these profiles mean?</summary>
  <p>Solo: Private to you • Team: Shared with team • Off: Local only</p>
</details>

<!-- Technical (external link) -->
<a href="docs-url">Learn about privacy and data handling →</a>
```

#### H2. Information Hierarchy

**Priority order:**
1. Action required (what do I do?)
2. Current state (where am I?)
3. Explanation (why does this matter?)
4. Technical details (how does it work?)

### I. Consent and Privacy

#### I1. Consent Dialog Improvements

**Current:**
```typescript
const consent = await vscode.window.showWarningMessage(
  `Applying these changes increases sharing: ${consent.reasons.join(', ')}. Continue?`,
  { modal: true },
  'I Consent',
  'Cancel'
);
```

**Proposed:**
```typescript
const consent = await vscode.window.showWarningMessage(
  'Confirm Privacy Changes',
  {
    modal: true,
    detail: `This will ${consent.reasons.join(' and ')}.\n\nYour data will be accessible to [audience]. Continue?`
  },
  'I Understand, Continue',
  'Cancel'
);
```

#### I2. Privacy Impact Summary

**Add to each profile:**
```html
<div class="privacy-impact">
  <strong>Who can see:</strong> Only you
  <strong>Data includes:</strong> Usage stats, workspace IDs
  <strong>Names stored:</strong> Yes
</div>
```

### J. Examples and Templates

#### J1. Provide Examples

**For every user input, show an example:**
```html
<label>Dataset ID</label>
<vscode-text-field 
  id="datasetId" 
  placeholder="my-team-copilot">
</vscode-text-field>
<div class="helper">Examples: "engineering-team", "project-alpha", "my-usage"</div>
```

#### J2. Templates

**For complex setup, offer templates:**
```typescript
const templates = [
  { 
    label: 'Personal Use',
    profile: 'soloFull',
    description: 'Track your own usage across devices'
  },
  { 
    label: 'Team Analytics',
    profile: 'teamAnonymized',
    description: 'Share team metrics, privacy-first'
  }
];
```

## Implementation Priority

### Phase 1: High Impact, Low Effort
1. Fix validation error messages (B1, B2)
2. Update command success/error messages (C1, C2)
3. Simplify config panel helper text (A1, A2, A3, A4)
4. Standardize terminology (G1, G2, G3)

### Phase 2: Medium Impact, Medium Effort
5. Improve wizard flow (D1, D2)
6. Update status indicators (E1, E2)
7. Add accessibility features (F1, F2, F3)
8. Implement progressive disclosure (H1)

### Phase 3: Lower Impact, Higher Effort
9. Create examples library (J1)
10. Add privacy impact summaries (I2)
11. Refactor consent dialogs (I1)
12. Build template system (J2)

## Success Criteria

### Quantitative
- Reduce average helper text length by 50-60%
- Achieve 100% WCAG 2.1 AA compliance
- Zero validation messages under 15 characters
- All error messages include recovery action

### Qualitative
- User can complete setup without external documentation
- Privacy implications are clear at decision point
- Validation errors guide user to correct input
- Professional tone consistent with VS Code ecosystem
- Screen reader users can complete all flows

## Migration Strategy

### 1. Create Language Guidelines Document
Document all terminology, message patterns, and examples in markdown file.

### 2. Create Helper Function Library
```typescript
// src/backend/ui/messages.ts
export const ValidationMessages = {
  required: (fieldName: string) => `${fieldName} is required`,
  range: (fieldName: string, min: number, max: number) => 
    `${fieldName} must be between ${min} and ${max}`,
  // ... etc
};

export const ErrorMessages = {
  wrap: (action: string, error: unknown) => 
    `Unable to ${action}. ${getSuggestion(error)}`,
  // ... etc
};
```

### 3. Update Components Systematically
- Update validation messages first (immediate user impact)
- Then command messages
- Then config panel content
- Finally wizard flows

### 4. Test with Real Users
- Beta test with 5-10 users
- Collect feedback on clarity
- Iterate on confusing areas

## Technical Notes

### String Extraction
Consider extracting all user-facing strings to:
- `src/backend/ui/strings.ts` for easy maintenance
- Enable future i18n if needed
- Centralize terminology

### Message Components
Create reusable message components:
```typescript
class MessageBuilder {
  static success(action: string): string;
  static error(action: string, details?: string, recovery?: string): string;
  static validation(field: string, rule: string, example?: string): string;
}
```

## Open Questions

1. Should we add a "Guided Setup" vs "Advanced Setup" mode to the config panel?
2. Do we need in-app contextual help tooltips, or is the current model sufficient?
3. Should privacy impact be shown before or after selecting a profile?
4. Is there value in adding a "Test Mode" that shows what would be synced without syncing?

## Next Steps

1. Review this spec with stakeholders
2. Get approval on terminology standards
3. Create tasks.md with specific implementation tasks
4. Prioritize Phase 1 items for immediate work
5. Create before/after mockups for config panel

---

**Document Status:** Draft for Review  
**Last Updated:** 2026-01-23  
**Owner:** Manager Agent  
**Stakeholders:** Extension users, developers, accessibility team
