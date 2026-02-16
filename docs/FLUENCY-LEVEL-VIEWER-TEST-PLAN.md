# Fluency Level Viewer - Test Plan

## Prerequisites

- VS Code installed
- Extension compiled (`npm run compile`)
- Extension loaded in VS Code

## Test Case 1: Access with Debugger Active

### Setup
1. Open a project in VS Code
2. Set a breakpoint in any file
3. Start debugging (F5 or Run → Start Debugging)
4. Wait for debugger to hit the breakpoint

### Test Steps
1. Open Command Palette (`Ctrl+Shift+P`)
2. Run "Copilot Token Tracker: Show Copilot Fluency Score"
3. **Verify**: Header shows "🔍 Level Viewer" button (should be visible)
4. Click the "🔍 Level Viewer" button
5. **Verify**: New panel opens titled "Fluency Level Viewer"
6. **Verify**: Header shows debug badge: "🐛 DEBUG MODE"
7. **Verify**: Info box explains this is a debug-only tool
8. **Verify**: 6 category buttons are displayed:
   - 💬 Prompt Engineering
   - 📎 Context Engineering
   - 🤖 Agentic
   - 🔧 Tool Usage
   - ⚙️ Customization
   - 🔄 Workflow Integration
9. **Verify**: First category (Prompt Engineering) is selected by default
10. **Verify**: 4 level cards are displayed (Stage 1-4)

### Expected Results
- Panel opens successfully
- All UI elements are visible and properly styled
- Debug mode indicator is shown
- All categories and stages are displayed

---

## Test Case 2: Access WITHOUT Debugger Active

### Setup
1. Open VS Code normally (no debugger running)
2. Ensure no debug sessions are active

### Test Steps - Via Command
1. Open Command Palette (`Ctrl+Shift+P`)
2. Run "Copilot Token Tracker: Show Fluency Level Viewer (Debug Only)"
3. **Verify**: Warning message appears: "Fluency Level Viewer is only available when a debugger is active."
4. **Verify**: "Learn More" button is shown
5. Click "Learn More"
6. **Verify**: Browser opens to VS Code debugging documentation

### Test Steps - Via Fluency Score Panel
1. Open Command Palette (`Ctrl+Shift+P`)
2. Run "Copilot Token Tracker: Show Copilot Fluency Score"
3. **Verify**: Header does NOT show "🔍 Level Viewer" button
4. **Verify**: Only standard buttons are shown (Refresh, Details, Chart, Usage, Diagnostics)

### Expected Results
- Command shows warning and does not open panel
- Button is hidden in Fluency Score panel when debugger is inactive
- Learn More redirects to appropriate documentation

---

## Test Case 3: Category Navigation

### Setup
1. Start debugger (see Test Case 1)
2. Open Fluency Level Viewer

### Test Steps
1. Click "📎 Context Engineering" button
2. **Verify**: Button becomes highlighted/active
3. **Verify**: Level cards update to show Context Engineering stages
4. **Verify**: Stage 1 shows "Not using explicit context references"
5. Click "🤖 Agentic" button
6. **Verify**: Previous selection (Context Engineering) is deselected
7. **Verify**: Agentic button becomes active
8. **Verify**: Level cards update to show Agentic stages
9. Click through all 6 categories
10. **Verify**: Each category displays unique content

### Expected Results
- Category selection changes the displayed stages
- Only one category is active at a time
- All categories are accessible
- Content matches the category selected

---

## Test Case 4: Stage Card Content Validation

### Setup
1. Start debugger
2. Open Fluency Level Viewer
3. Select "💬 Prompt Engineering"

### Test Steps for Stage 1
1. **Verify** Stage 1 card shows:
   - Title: "Stage 1: Copilot Skeptic"
   - Badge: "Stage 1" (red background)
   - Description: "Rarely uses Copilot or uses only basic features"
   - Requirements section with 3+ items
   - Tips section with 2+ items
2. **Verify** red left border on Stage 1 card

### Test Steps for Stage 2
1. **Verify** Stage 2 card shows:
   - Title: "Stage 2: Copilot Explorer"
   - Badge: "Stage 2" (orange background)
   - Requirements section
   - Tips section
2. **Verify** orange left border on Stage 2 card

### Test Steps for Stage 3
1. **Verify** Stage 3 card shows:
   - Title: "Stage 3: Copilot Collaborator"
   - Badge: "Stage 3" (blue background)
   - Requirements section
   - Tips section
2. **Verify** blue left border on Stage 3 card

### Test Steps for Stage 4
1. **Verify** Stage 4 card shows:
   - Title: "Stage 4: Copilot Strategist"
   - Badge: "Stage 4" (green background)
   - Requirements section
   - Tips: "You're at the highest level!" (no advancement tips)
2. **Verify** green left border on Stage 4 card

### Expected Results
- All stages display correct labels and colors
- Requirements are specific and measurable
- Tips are actionable and stage-appropriate
- Stage 4 acknowledges it's the highest level

---

## Test Case 5: Navigation Buttons

### Setup
1. Start debugger
2. Open Fluency Level Viewer

### Test Steps
1. Click "🔄 Refresh" button
2. **Verify**: Panel refreshes (content reloads)
3. Click "🎯 Fluency Score" button
4. **Verify**: Navigate back to Fluency Score panel
5. Open Level Viewer again
6. Click "🤖 Details" button
7. **Verify**: Navigate to Details panel
8. Open Level Viewer again
9. Click "📈 Chart" button
10. **Verify**: Navigate to Chart panel
11. Open Level Viewer again
12. Click "📊 Usage Analysis" button
13. **Verify**: Navigate to Usage Analysis panel
14. Open Level Viewer again
15. Click "🔍 Diagnostics" button
16. **Verify**: Navigate to Diagnostics panel

### Expected Results
- All navigation buttons work correctly
- Panels open in expected locations
- Navigation is smooth and consistent

---

## Test Case 6: Responsive Layout

### Setup
1. Start debugger
2. Open Fluency Level Viewer

### Test Steps
1. Resize VS Code window to narrow width (< 800px)
2. **Verify**: Category buttons wrap to multiple rows
3. **Verify**: Level cards stack vertically
4. Resize window to wide width (> 1400px)
5. **Verify**: Level cards display in grid (2+ columns)
6. **Verify**: All content remains readable

### Expected Results
- Layout adapts to window size
- No content is cut off or hidden
- Text remains readable at all sizes

---

## Test Case 7: Debug Mode Toggle

### Setup
1. Start debugger
2. Open both Fluency Score panel and Level Viewer panel side-by-side

### Test Steps
1. **Verify**: Fluency Score panel shows "🔍 Level Viewer" button
2. **Verify**: Level Viewer shows debug badge
3. Stop debugger (press Stop or Shift+F5)
4. Wait 2 seconds
5. Click "Refresh" in Fluency Score panel
6. **Verify**: "🔍 Level Viewer" button disappears
7. Close Level Viewer panel
8. Try to open via Command Palette
9. **Verify**: Warning message appears
10. Start debugger again
11. Refresh Fluency Score panel
12. **Verify**: "🔍 Level Viewer" button reappears

### Expected Results
- Button visibility changes based on debug state
- Level Viewer access is properly gated
- Debug state is detected dynamically

---

## Test Case 8: Content Accuracy

### Setup
1. Review `src/extension.ts` method `calculateMaturityScores()`
2. Start debugger
3. Open Fluency Level Viewer

### Test Steps
1. For each category, compare Level Viewer thresholds with source code
2. **Verify**: Stage 1 thresholds match lines ~5288-5324 (Prompt Engineering)
3. **Verify**: Stage 2 thresholds match corresponding code sections
4. **Verify**: Stage 3 thresholds match corresponding code sections
5. **Verify**: Stage 4 thresholds match corresponding code sections
6. Repeat for all 6 categories

### Expected Results
- All thresholds in Level Viewer match the scoring algorithm
- Tips are relevant and actionable
- No discrepancies between display and logic

---

## Test Case 9: Extension Commands Registration

### Setup
1. Load extension in VS Code
2. Open Developer Console (Help → Toggle Developer Tools)

### Test Steps
1. Run in console: `await vscode.commands.getCommands(true)`
2. **Verify**: List includes `copilot-token-tracker.showFluencyLevelViewer`
3. Check package.json
4. **Verify**: Command is listed in contributes.commands
5. Run automated test: `npm test`
6. **Verify**: Test "Commands should be registered" passes

### Expected Results
- Command is properly registered
- Tests pass
- No errors in console

---

## Test Case 10: Memory/Performance

### Setup
1. Start debugger
2. Open Developer Console

### Test Steps
1. Open Level Viewer
2. Monitor memory usage
3. Switch between all 6 categories 10 times
4. **Verify**: No memory leaks
5. **Verify**: Category switching is instant (< 100ms)
6. Close and reopen Level Viewer 5 times
7. **Verify**: No performance degradation
8. Check console for errors
9. **Verify**: No errors or warnings

### Expected Results
- Smooth performance
- No memory leaks
- No console errors
- Fast category switching

---

## Regression Test Checklist

After implementing this feature, verify that existing functionality still works:

- [ ] Fluency Score panel opens correctly
- [ ] Fluency Score calculation is unchanged
- [ ] All other navigation buttons work
- [ ] Tips can be dismissed
- [ ] MCP discovery button works
- [ ] Other panels (Details, Chart, Usage, Diagnostics) open correctly
- [ ] Extension compiles without errors
- [ ] All tests pass
- [ ] No TypeScript errors
- [ ] No ESLint warnings

---

## Browser Compatibility

Test in VS Code with different webview engines:

- [ ] Windows (Electron)
- [ ] macOS (Electron)
- [ ] Linux (Electron)
- [ ] VS Code Web (if applicable)

---

## Accessibility

- [ ] Keyboard navigation works (Tab through buttons)
- [ ] Screen reader announces category changes
- [ ] Color contrast meets WCAG AA standards
- [ ] Focus indicators are visible

---

## Documentation Review

- [ ] FLUENCY-LEVEL-VIEWER.md is accurate
- [ ] README mentions the debug feature
- [ ] Inline code comments are clear
- [ ] No broken links in documentation
