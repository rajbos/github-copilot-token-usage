---
title: UI Language Quick Reference
description: Standards and patterns for consistent user-facing messaging
lastUpdated: 2026-01-26
status: current
project: ui-improvement
---

# UI Language Quick Reference

Quick reference for consistent messaging across the extension.

## Terminology Standards

### Capitalization
| Term | Format | Example |
|------|--------|---------|
| Backend | Cap when feature, lower when technical | "Backend is enabled" / "sync to backend" |
| Dataset ID | Always capitalized | "Enter your Dataset ID" |
| Shared Key | Always capitalized | "Storage Account Shared Key" |
| Entra ID | Always this format | "Sign in with Entra ID" |

### Replacements
| ❌ Don't Use | ✅ Use Instead | Why |
|-------------|---------------|-----|
| RBAC | role-based access | Avoid jargon |
| GUID | unique identifier | Avoid jargon |
| rollups | usage summaries | User-friendly |
| data plane | storage connection | Too technical |

### Action Verbs
- ✅ Sync ❌ push to backend
- ✅ Remove ❌ clear
- ✅ Update ❌ rotate (for non-crypto contexts)
- ✅ Export ❌ copy to clipboard

## Message Patterns

### Validation Errors

```typescript
// ❌ Bad
errors.field = 'Required';
errors.lookbackDays = '1-90';

// ✅ Good
errors.field = 'Field name is required. Example: "value"';
errors.lookbackDays = 'Must be between 1 and 90 days';
```

**Pattern:** `[What's wrong]. [How to fix]. [Example if helpful]`

### Success Messages

```typescript
// ❌ Bad
'The operation completed successfully and your changes have been saved to the configuration.'

// ✅ Good
'Settings saved successfully'
```

**Pattern:** `[Action] [status]` - Keep under 5 words.

### Error Messages

```typescript
// ❌ Bad
`Error: ${error.message}`
`Failed: ${technicalDetails}`

// ✅ Good
'Unable to sync to Azure. Check your connection and try again.'
'Unable to save settings. Ensure all required fields are filled.'
```

**Pattern:** `Unable to [action]. [Suggestion].` - Always include recovery action.

### Confirmation Dialogs

```typescript
// ❌ Bad
vscode.window.showWarningMessage(
  'This will do something. Are you sure?',
  'Yes'
);

// ✅ Good
vscode.window.showWarningMessage(
  'Remove stored shared key?',
  { 
    modal: true,
    detail: 'You will need to re-enter the key to sync again.'
  },
  'Remove Key'
);
```

**Pattern:** Question as title, consequence as detail, action as button.

### Help Text

```typescript
// ❌ Bad
'This field is used to configure the dataset identifier which groups your usage data in the backend storage system and allows you to...'

// ✅ Good
'Dataset ID groups your usage data. Examples: "my-team", "project-alpha"'
```

**Pattern:** `[What it does]. [Example/next step]` - One sentence, then examples.

## Component-Specific Guidelines

### Config Panel Sections

**Overview**
- Purpose: Show current state and primary actions
- Max text: 50 words per card
- Include: Status badges, primary actions, brief explanation

**Sharing/Azure/Advanced**
- Max helper text: 30 words per field
- Always provide example
- Use progressive disclosure for details

### Wizard Steps

**Title format:** `Step [X] of [Y]: [Purpose]`
```typescript
{ title: 'Step 2 of 5: Choose Resource Group' }
```

**Placeholder format:** Realistic example, not instruction
```typescript
// ❌ Bad
{ placeHolder: 'Enter a name for your resource group' }

// ✅ Good
{ placeHolder: 'copilot-tokens-rg' }
```

### Status Indicators

**Badge format:** Brief status only
```typescript
// ❌ Bad
'Backend: Currently Enabled and Syncing'

// ✅ Good
'Backend Enabled'
```

**Status line format:** Icon + clear message
```typescript
// ❌ Bad
'The connection test was successful and you are able to read and write to the backend table.'

// ✅ Good
'✓ Connected to Azure Storage successfully'
```

## Privacy & Consent

### Sharing Profiles

Use consistent short descriptions:
- **Off** – All data stays local
- **Solo** – Your private cloud storage
- **Team Anonymized** – Hashed IDs, no names
- **Team Pseudonymous** – Stable alias only
- **Team Identified** – Full identifier included

### Consent Language

Always include:
1. What's changing
2. Who will see what
3. Clear action button

```typescript
await vscode.window.showWarningMessage(
  'Confirm Privacy Changes',
  {
    modal: true,
    detail: 'Your workspace names will be stored in Azure. Team members with storage access can see these names. Continue?'
  },
  'I Understand, Continue',
  'Cancel'
);
```

## Accessibility Requirements

### ARIA Labels
```html
<!-- ❌ Bad -->
<vscode-button id="testBtn">Test</vscode-button>

<!-- ✅ Good -->
<vscode-button id="testBtn" aria-label="Test connection to Azure Storage">
  Test Connection
</vscode-button>
```

### Error Association
```html
<!-- ❌ Bad -->
<vscode-text-field id="field"></vscode-text-field>
<div class="error">Error message</div>

<!-- ✅ Good -->
<vscode-text-field 
  id="field" 
  aria-describedby="field-help field-error"
  aria-invalid="true">
</vscode-text-field>
<div id="field-help" class="helper">Help text</div>
<div id="field-error" class="error" role="alert">Error message</div>
```

### Live Regions
```html
<!-- For status updates that should be announced -->
<div id="status" aria-live="polite" role="status"></div>

<!-- For errors that need immediate attention -->
<div id="error" aria-live="assertive" role="alert"></div>
```

## Examples Library

### Dataset ID
```
my-team-copilot
engineering-team
project-alpha
personal-usage
```

### Storage Account Names
```
copilottokensrg
teamusagestg
personalcopilotstorage
```

### Team Aliases
```
alex-dev
maria-eng
team-frontend
qa-team-1
```

## Testing Checklist

Before shipping any UI change:

- [ ] All text under recommended length limits
- [ ] Terminology matches standards
- [ ] Examples provided where helpful
- [ ] Error messages include recovery action
- [ ] ARIA labels on interactive elements
- [ ] Keyboard navigation works
- [ ] Screen reader tested (if webview)
- [ ] No jargon without explanation
- [ ] Consistent tone (not mixing formal/casual)
- [ ] Privacy implications clear
- [ ] Action outcomes clear before user commits

## Common Scenarios

### When User Makes a Mistake
Focus on helping them succeed, not on the error:
```typescript
// ❌ Bad
'Invalid input. The value you entered does not match the required format.'

// ✅ Good
'Dataset ID must use only letters, numbers, and dashes. Example: "my-team-copilot"'
```

### When Something Fails
Include what to check/try next:
```typescript
// ❌ Bad
'Sync failed: HttpException: 403 Forbidden'

// ✅ Good
'Unable to sync to Azure. Check that your account has write permission to the storage account.'
```

### When Ask Asking for Consent
Be transparent about implications:
```typescript
// ❌ Bad
'Enable team sharing?'

// ✅ Good  
'Share usage data with team?'
// With detail:
'Team members with storage access will see your usage stats and workspace names. Continue?'
```

## Anti-Patterns to Avoid

❌ **Walls of text** - Break up into scannable chunks
❌ **Jargon without context** - Define or replace technical terms
❌ **Apologetic tone** - "Sorry, but..." → Just state the fact
❌ **Uncertainty** - "This might..." → "This will..."
❌ **Redundancy** - Don't repeat info available elsewhere
❌ **Passive voice** - "Settings will be saved" → "Save settings"
❌ **Technical details in errors** - Show action path, hide stack traces
❌ **Ambiguous pronouns** - "It", "this", "that" → Use specific nouns

## Questions?

When in doubt:
1. Can a new user understand this without documentation?
2. Does it clearly state what will happen?
3. Is there a simpler way to say it?
4. Does it follow the VS Code extension voice and tone?
5. Would it work with a screen reader?

If any answer is "no", revise before shipping.
