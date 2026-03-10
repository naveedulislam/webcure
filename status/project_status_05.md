# WebCure — Project Status Report #05

**Date:** 2026-03-10  
**Author:** Naveed ul Islam  
**Version:** 1.1.3  
**Repository:** https://github.com/naveedulislam/webcure.git  
**Previous Report:** [project_status_04.md](project_status_04.md)

---

## Executive Summary

This session addressed three issues identified in a diagnostic report about the Step Recorder's inability to capture actions on **Radix UI** components (used by the AVIQ app). Two of the three issues were fixed and verified against the live Radix UI Themes Playground. Additionally, **CLI commands for the Step Recorder** were added so that AI agents can start and stop automatic step recording via the file bridge, closing a gap where the feature was only accessible through the VS Code Command Palette.

---

## Diagnostic Report (Input)

A Cursor agent was tasked with navigating to the AVIQ app at `http://localhost:3000` and diagnosing why the Step Recorder failed to capture certain interactions. The agent produced a report identifying three issues:

| #   | Issue                                                        | Root Cause                                                                                                    |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | Browser does not open maximized                              | Hardcoded viewport of 1280×800, no `--start-maximized` arg                                                    |
| 2   | Clicking Radix UI dropdown trigger ("+ New") is not recorded | Radix opens menu on `pointerdown`; the subsequent `click` fires on `document.body` which the recorder ignores |
| 3   | Menu item clicks described generically                       | No ARIA role awareness; "Clicked on div 'Entitlement Review'" instead of dropdown context                     |

---

## Changes Made

### Issue 1: Browser Maximize — Not Changed

**Decision:** The `--start-maximized` Chrome flag and `viewport: null` changes were implemented and tested, but caused the browser to open blank pages on macOS. The page failed to render properly without an explicit viewport size. This change was **reverted** to preserve stability. The browser continues to launch with a 1280×800 viewport.

**File:** `src/browserManager.ts` — no net changes.

### Issue 2: `pointerdown` Listener for Radix UI Dropdown Triggers

**Problem:** Radix UI's `DropdownMenu` component opens the menu portal on the `pointerdown` event, not `click`. This causes the `pointerup` to land on the newly rendered menu overlay, and the `click` event fires on `document.body` (the common ancestor). The Step Recorder's click listener explicitly ignores `document.body` clicks, so the dropdown trigger click was never recorded.

**Fix (`src/recorder/step-recorder.ts`):** Added a `pointerdown` event listener (in the injected browser script) that captures clicks on interactive elements before the menu portal can intercept them:

- Listens on `document.addEventListener('pointerdown', ...)` with `capture: true`
- Only fires for interactive elements: `<button>`, `<a>`, `[role="button"]`, `[aria-haspopup]`, `[data-slot="dropdown-menu-trigger"]`
- Resolves to the nearest interactive ancestor if the direct target is a child (e.g., an `<svg>` icon inside a button)
- Records the event as a `click` action with full element identification

**Deduplication:** A tracking mechanism (`lastPointerdownTarget` + `lastPointerdownTime`) prevents double-recording when both `pointerdown` and `click` fire on the same element within 500ms.

### Issue 3: ARIA Role Awareness for Menu Items

**Problem:** Radix dropdown menu items are `<div role="menuitem">` elements. The Step Recorder had no awareness of ARIA roles, so clicking a menu item was recorded as `Clicked on div 'Entitlement Review'` with no context about which dropdown it belonged to.

**Fix (`src/recorder/step-recorder.ts`):** Two changes:

1. **`extractElementIdentifier()`** (injected browser script) now:
   - Reads the `role` attribute from clicked elements
   - Detects `role="menuitem"`, `role="menuitemcheckbox"`, `role="menuitemradio"`, `role="option"`, and `data-slot="dropdown-menu-item"`
   - Walks up the DOM to find the parent `[role="menu"]`, `[role="listbox"]`, or `[role="menubar"]` container
   - Reads `aria-labelledby` on the container to locate the trigger element and extract its label text
   - Falls back to `aria-label` on the container if `aria-labelledby` is not present
   - Returns `role` and `menuTriggerLabel` fields in the element identifier

2. **`formatActionDescription()`** now:
   - Checks for ARIA menu roles before the generic click/type handling
   - Produces context-aware descriptions:
     - `Selected 'Duplicate ⌘ D' from 'Options' dropdown` (when trigger label is found)
     - `Selected menu item 'Duplicate ⌘ D'` (when no trigger label is available)

### New Feature: Step Recorder CLI Commands

**Problem:** The Step Recorder ("Record Steps - Automatic") was only accessible via the VS Code Command Palette. AI agents using the file bridge CLI had no way to start or stop automatic step recording programmatically.

**Fix:** Added two new commands to the file bridge and CLI:

| CLI Command                     | Description                                                    |
| ------------------------------- | -------------------------------------------------------------- |
| `startStepRecorder [url=<URL>]` | Start automatic step recording, optionally navigating to a URL |
| `stopStepRecorder`              | Stop step recording and generate the Markdown output           |

**Files changed:**

- **`src/bridge/file-bridge.ts`** — Imported `startStepRecorder` and `stopStepRecorder` from `step-recorder.ts`; added two new `case` handlers in the `executeCommand` switch
- **`src/bridge/cli-template.js`** — Added help text entries for both new commands

**Usage:**

```bash
node .webcure/cli.js startStepRecorder url=https://example.com
# ... user interacts with the browser ...
node .webcure/cli.js stopStepRecorder
```

---

## Files Changed

| File                            | Type     | Changes                                                                                                                                                                                                     |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/recorder/step-recorder.ts` | Modified | Added `pointerdown` listener (+39 lines), ARIA role detection in `extractElementIdentifier` (+26 lines), menu-aware formatting in `formatActionDescription` (+12 lines), deduplication tracking (+13 lines) |
| `src/bridge/file-bridge.ts`     | Modified | Imported step-recorder module, added `startStepRecorder` and `stopStepRecorder` command cases (+12 lines)                                                                                                   |
| `src/bridge/cli-template.js`    | Modified | Added help text for two new CLI commands (+2 lines)                                                                                                                                                         |
| `status/project_status_05.md`   | **New**  | This file                                                                                                                                                                                                   |

---

## Test Results

### Step Recorder — Radix UI Dropdown Test (Manual)

Test site: [Radix UI Themes Playground](https://www.radix-ui.com/themes/playground) — Dropdown Menu section

| Step | Action                           | Expected Recording                      | Actual Recording                                                               | Result |
| ---- | -------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| 1    | Navigate to Radix playground     | Navigation step recorded                | `Performed 'navigate' on 'Navigated to https://www.radix-ui.com/themes/playg'` | PASS   |
| 2    | Click "Options" dropdown trigger | Button click recorded (via pointerdown) | `Clicked on button 'Options'`                                                  | PASS   |
| 3    | Click "Duplicate" menu item      | Menu item with dropdown context         | `Selected 'Duplicate ⌘ D' from 'Options' dropdown`                             | PASS   |
| 4    | Click second "Options" dropdown  | Button click recorded                   | `Clicked on button 'Options'`                                                  | PASS   |
| 5    | Click "Duplicate" menu item      | Menu item with dropdown context         | `Selected 'Duplicate ⌘ D' from 'Options' dropdown`                             | PASS   |
| 6    | Close browser                    | Close step recorded                     | `Performed 'close' on 'Browser window closed'`                                 | PASS   |

### Step Recorder CLI Commands

| Test                                                               | Result                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `startStepRecorder url=https://www.radix-ui.com/themes/playground` | `{"status": "ok", "result": {"recording": true}}` — PASS |
| `stopStepRecorder`                                                 | Recording stopped, Markdown generated — PASS             |

---

## Known Issue: Extension Reinstall Requires Process Restart

During testing, the new CLI commands (`startStepRecorder` / `stopStepRecorder`) returned "Unknown command" after installing the updated VSIX and reloading VS Code — even after fully quitting VS Code (Cmd+Q) and reinstalling three times. Investigation confirmed:

- The installed extension files on disk were **correct** (the compiled `file-bridge.js` contained the new `case` handlers)
- The `.webcure/cli.js` was regenerated with the new help text (proving the new extension code activated)
- Yet the bridge returned "Unknown command" for the new cases

The issue resolved after a **full Mac restart**, suggesting that stale Chromium or Node.js processes from previous extension host sessions were interfering. This is a known behavior with Playwright-managed browser processes that can outlive VS Code. For users who encounter this after installing updates:

**Workaround:** After installing an updated VSIX, if new commands return "Unknown command":

1. Quit VS Code completely (Cmd+Q)
2. Kill any stale Chrome/Chromium processes: `pkill -f "Google Chrome"` or `pkill -f chromium`
3. Relaunch VS Code

---

## Verification

- `npm run compile` — Clean, no errors
- `npm run package` — VSIX built successfully (webcure-1.0.0.vsix)
- VSIX installed and tested in VS Code
- Radix UI Themes Playground used as test site — all dropdown interactions recorded correctly

---

## Next Steps

- [ ] Investigate `--start-maximized` / `viewport: null` blank page issue on macOS for a proper fix
- [ ] Step Recorder: Generate resilient Python scripts with CSS selector + XPath fallback
- [ ] Publish `webcure` Python package to PyPI
- [ ] Add automated integration tests for recording workflow
- [ ] CI/CD pipeline for automated testing on commits
- [ ] Bundle the extension (webpack/esbuild) to reduce VSIX size and file count
