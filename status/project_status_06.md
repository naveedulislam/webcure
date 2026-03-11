# WebCure — Project Status Report #06

**Date:** 2026-03-10  
**Author:** Naveed ul Islam  
**Version:** 1.0.0  
**Repository:** https://github.com/naveedulislam/webcure.git  
**Previous Report:** [project_status_05.md](project_status_05.md)

---

## Executive Summary

This session redesigned the Step Recorder's event capture mechanism to handle **Radix UI Select** components (and similar portal-based dropdowns where the DOM element is removed before `mouseup`). The previous whitelisted `pointerdown` approach from Status Report #05 was replaced with a **deferred pointerdown** strategy that universally handles any component library without needing selector whitelists. Additionally, a `restartExtensionHost` CLI command was added, the VSIX build output was simplified to the project root, and a `getExistingPage()` method was added to prevent blank browser windows during step recording.

---

## Problem Statement

After the Radix UI DropdownMenu fixes in Status Report #05, testing revealed that **Radix UI Select** components (role="combobox") were also not being recorded. When a user clicks a Select option:

1. The `<div role="option">` element receives `pointerdown`
2. Radix immediately removes the option from the DOM (closes the portal)
3. `mouseup` and `click` events fire on `document.body` (the common ancestor after removal)
4. The Step Recorder's click listener ignores `document.body` clicks → **option selection not recorded**

The whitelisted `pointerdown` listener from #05 only matched specific selectors (`button`, `a`, `[aria-haspopup]`, `[data-slot="dropdown-menu-trigger"]`) and did not cover `<span>` elements inside `[role="option"]` or arbitrary interactive elements from other component libraries.

---

## Changes Made

### 1. Deferred Pointerdown Strategy (`step-recorder.ts`)

**Replaced** the whitelisted pointerdown approach with a universal "deferred pointerdown" mechanism:

**Before (Status #05):** Pointerdown listener checked a hardcoded list of interactive selectors. If the element matched, it was recorded immediately and deduplicated against subsequent clicks via a 500ms time window.

**After:** The recorder captures ALL pointerdowns on meaningful targets, then defers recording:

1. On `pointerdown`: resolve the target to the nearest interactive element using `resolveInteractiveElement()`, extract its identifier, and start a 400ms timer
2. If a `click` event fires on the same element within 400ms → cancel the timer, let the click handler record it (better timing — element is still in DOM)
3. If NO `click` fires within 400ms (element was removed from DOM, e.g. Radix Select option) → timer fires and records the pointerdown as a click
4. If a `click` fires on a DIFFERENT element → commit the orphaned pointerdown, then record the new click
5. Body/document clicks are ignored entirely (deferred timer handles them)

**New helper — `resolveInteractiveElement(target)`:** Walks up from the raw event target to the nearest semantically meaningful ancestor using a comprehensive `INTERACTIVE_SELECTOR`:

```
button, a, input, select, textarea,
[role="button"], [role="option"], [role="menuitem"],
[role="menuitemcheckbox"], [role="menuitemradio"],
[role="tab"], [role="treeitem"], [role="combobox"],
[role="switch"], [role="link"], [role="checkbox"],
[role="radio"], [aria-haspopup],
[data-slot="dropdown-menu-trigger"],
[data-slot="dropdown-menu-item"],
[data-slot="select-trigger"],
[data-slot="select-item"]
```

**ARIA detection update:** Added `data-slot="select-item"` to the list of recognized menu/option items for trigger label resolution.

### 2. `getExistingPage()` Method (`browserManager.ts`)

**Problem:** The `handleBrowserStep()` function in the step recorder called `BrowserManager.getPage()` to take screenshots. `getPage()` creates a new browser if none exists — which caused blank browser windows to open after the user closed the browser during recording.

**Fix:** Added `getExistingPage()` method that returns the current page if open, or `undefined` if not — without creating a new browser. Updated `handleBrowserStep()` to use this method instead of `getPage()`.

### 3. `restartExtensionHost` CLI Command (`file-bridge.ts`, `cli-template.js`)

**Problem:** After installing an updated VSIX, the old extension code often continues running until the extension host is fully restarted. Users had to manually use the Command Palette to restart it.

**Fix:** Added a `restartExtensionHost` command to the file bridge that calls `vscode.commands.executeCommand('workbench.action.restartExtensionHost')`. This allows AI agents and CLI users to restart the extension host programmatically:

```bash
node .webcure/cli.js restartExtensionHost
```

### 4. VSIX Build Path Simplification (`package.json`, `.vscodeignore`, `README.md`)

**Problem:** The `npm run package` script output to `dist/webcure.vsix` via `vsce package -o dist/webcure.vsix`. This required creating the `dist/` directory and used a non-standard output name.

**Fix:**

- Changed `package.json` script to `"package": "vsce package"` — uses default `vsce` behavior, outputting `webcure-<version>.vsix` (e.g., `webcure-1.0.0.vsix`) to the project root
- Added `*.vsix` to `.vscodeignore` to prevent VSIX files from being packaged inside future builds
- Updated all `README.md` references from `dist/webcure.vsix` to `webcure-1.0.0.vsix`

---

## Files Changed

| File                            | Type     | Changes                                                                                                                                                                                                                                                               |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/recorder/step-recorder.ts` | Modified | Replaced whitelisted pointerdown with deferred pointerdown strategy; added `resolveInteractiveElement()`, `INTERACTIVE_SELECTOR`; updated `handleBrowserStep()` to use `getExistingPage()`; added `data-slot="select-item"` to ARIA detection (+130 lines, -67 lines) |
| `src/browserManager.ts`         | Modified | Added `getExistingPage()` method (+11 lines)                                                                                                                                                                                                                          |
| `src/bridge/file-bridge.ts`     | Modified | Added `restartExtensionHost` command case (+7 lines)                                                                                                                                                                                                                  |
| `src/bridge/cli-template.js`    | Modified | Added help text for `restartExtensionHost` (+1 line)                                                                                                                                                                                                                  |
| `package.json`                  | Modified | Changed `package` script from `mkdir -p dist && vsce package -o dist/webcure.vsix` to `vsce package`                                                                                                                                                                  |
| `.vscodeignore`                 | Modified | Added `*.vsix` exclusion (+1 line)                                                                                                                                                                                                                                    |
| `README.md`                     | Modified | Updated VSIX path references, deferred pointerdown docs, Select support, `restartExtensionHost`, project structure                                                                                                                                                    |
| `status/project_status_06.md`   | **New**  | This file                                                                                                                                                                                                                                                             |

---

## Test Results

### Step Recorder — Radix UI Select + Dropdown Menu Test (Manual)

Test site: [Radix UI Themes Playground](https://www.radix-ui.com/themes/playground)

| Step | Action                                          | Expected Recording                               | Actual Recording                                                               | Result |
| ---- | ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | ------ |
| 1    | Navigate to Radix playground                    | Navigation step recorded                         | `Performed 'navigate' on 'Navigated to https://www.radix-ui.com/themes/playg'` | PASS   |
| 2    | Click Select trigger ("Apple")                  | Button click recorded (via deferred pointerdown) | `Clicked on button 'Apple'`                                                    | PASS   |
| 3    | Click Select option ("Orange")                  | Menu item with option text                       | `Selected menu item 'Orange'`                                                  | PASS   |
| 4    | Click "Options" dropdown trigger (Solid Accent) | Button click recorded                            | `Clicked on button 'Options'`                                                  | PASS   |
| 5    | Click "Duplicate" menu item                     | Menu item with dropdown context                  | `Selected 'Duplicate ⌘ D' from 'Options' dropdown`                             | PASS   |
| 6    | Click "Options" dropdown trigger (Solid Gray)   | Button click recorded                            | `Clicked on button 'Options'`                                                  | PASS   |
| 7    | Click "Archive" menu item                       | Menu item with dropdown context                  | `Selected 'Archive ⌘ N' from 'Options' dropdown`                               | PASS   |
| 8    | Click "Options" dropdown trigger (Soft Accent)  | Button click recorded                            | `Clicked on button 'Options'`                                                  | PASS   |
| 9    | Click "Edit" menu item                          | Menu item with dropdown context                  | `Selected 'Edit ⌘ E' from 'Options' dropdown`                                  | PASS   |
| 10   | Click "Options" dropdown trigger (Soft Gray)    | Button click recorded                            | `Clicked on button 'Options'`                                                  | PASS   |
| 11   | Click "Edit" menu item                          | Menu item with dropdown context                  | `Selected 'Edit ⌘ E' from 'Options' dropdown`                                  | PASS   |
| 12   | Close browser                                   | Close step recorded                              | `Performed 'close' on 'Browser window closed'`                                 | PASS   |

**All 12 steps passed.** Both Radix UI Select options (deferred pointerdown) and Dropdown Menu items (deferred pointerdown + ARIA trigger lookup) are correctly captured.

---

## Known Issues

### Multi-IDE Extension Conflict

Having WebCure installed simultaneously on VS Code, Cursor, and Antigravity causes Playwright Chrome instance conflicts — the browser opens blank pages on resize. **Resolution:** Install the extension on only one IDE at a time, or uninstall from the others before testing.

### Browser Maximize (`--start-maximized`) Not Supported on macOS

The `--start-maximized` Chrome flag combined with `viewport: null` causes blank pages on macOS. The browser continues to launch with a fixed 1280×800 viewport. This remains an open investigation item.

---

## Verification

- `npm run compile` — Clean, no errors
- `npm run package` — VSIX built successfully (`webcure-1.0.0.vsix`)
- VSIX installed and tested in VS Code
- Radix UI Themes Playground used as test site — both Select and Dropdown Menu interactions recorded correctly across 12 steps

---

## Next Steps

- [ ] Test on local application (AVIQ) to verify Radix UI recording in production
- [ ] Investigate `--start-maximized` / `viewport: null` blank page issue on macOS
- [ ] Step Recorder: Generate resilient Python scripts with CSS selector + XPath fallback
- [ ] Publish `webcure` Python package to PyPI
- [ ] Add automated integration tests for recording workflow
- [ ] CI/CD pipeline for automated testing on commits
- [ ] Bundle the extension (webpack/esbuild) to reduce VSIX size and file count
