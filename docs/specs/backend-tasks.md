---
title: Backend Implementation Tasks
description: Task tracking for Azure Storage backend feature implementation
status: complete
lastUpdated: 2026-01-26
project: backend
---

# Backend Implementation Tasks

**Status:** ✅ ALL TASKS COMPLETE  
**Project:** Backend Azure Storage synchronization

<!-- NEXT: - -->

## DONE 1: UX design for backend settings configurator
- UX flow defined (command to open panel with nav: Overview ▸ Sharing ▸ Azure ▸ Advanced ▸ Review & Apply), privacy badges, Save & Apply CTA, consent modal for more permissive sharing/readable names, defaults (backend off, shareWithTeam=false, anonymize names on), and offline/local-only handling.
- Sharing step: profile picker (Off/Solo/Team Anonymized/Team Pseudonymous/Team Identified), consent gate when increasing scope, toggles for anonymizing names and machine breakdown, helper copy.
- Azure step: required IDs with inline validation, status chip for auth, offline banner, secret key handled via “Update key” (SecretStorage) without echo.
- Advanced: datasetId, lookbackDays (1-90 validation), backend enabled toggle; Review & Apply summary with confirmation checkbox; discard/unsaved prompts captured.

## DONE 2: Implement VS Code command for backend settings configuration
- Added backend settings panel with toolkit navigation, consent messaging, offline-aware test button, Review & Apply flow, and validation integrated into backend facade; compile succeeded.
- Shared key update handled via SecretStorage without echo; settings persisted with privacy defaults and consent gating.

## DONE 3: Tests and docs for settings configurator
- Added coverage for configurator validation (alias rules, lookback bounds), consent gating, shared key update, routing, and offline behavior; tests run with npm test passed.
- README configurator docs already present; no further updates required.

## DONE 4: Clarify UI copy and overview layout for backend settings
- Over-explained helper text and examples added for sharing profiles, readable vs anonymized names, machine breakdown, datasetId, and lookbackDays (with 7/30/90-day examples) and surfaced where edited.
- Overview now highlights enable-backend toggle plus privacy/auth badges up front and clarifies “Stay Local”.

## DONE 5: UI/feature updates for backend configurator
- Test connection wired with inline status and offline/unauth disable; shared-key button hidden unless shared-key auth is active.
- Azure tab now links to the configure walkthrough, places enable-backend before resource IDs, and refines Overview badges/CTAs.

## DONE 6: Tests and docs for new configurator changes
- Added tests for connection flow states, shared-key gating, enable-first layout, overview badges/Stay Local messaging, and wizard launch callbacks.
- Updated README backend configurator docs with lookbackDays examples, test connection/shared-key visibility rules, offline behavior, wizard entry point, and Stay Local/privacy guidance.
- Ran npm run compile and npm test (passed).
