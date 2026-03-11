# WebCure — Project Status Report #07

**Date:** 2026-03-11  
**Author:** Naveed ul Islam  
**Version:** 1.0.0  
**Repository:** https://github.com/naveedulislam/webcure.git  
**Previous Report:** [project_status_06.md](project_status_06.md)

---

## Executive Summary

This session implemented a **standards-based HTML Element Rules Engine** (`element-rules-engine.ts`, 700 lines) that replaces the ad-hoc element identification logic in the Step Recorder with a W3C-compliant classification system. The engine resolves ARIA roles (HTML-AAM), computes accessible names (Accname 1.2), generates ranked locator strategies, and produces human-readable action descriptions — all as pure vanilla browser JS with zero runtime dependencies.

Comprehensive testing was performed at two levels:

- **113 TypeScript unit tests** covering all 10 engine sections against synthetic HTML
- **63 Python live browser integration tests** against 4 real websites (demo.testfire.net, the-internet.herokuapp.com, Radix UI Themes Playground, W3C WAI-ARIA Practices)

All **176 tests pass with zero failures**.

---

## Problem Statement

The Step Recorder's element identification logic was scattered across `step-recorder.ts` (616 lines) using hardcoded selectors and string-matching heuristics. This approach:

1. Required manual additions for each new component library (e.g., Radix-specific `data-slot` selectors)
2. Could not classify ARIA roles from custom elements (`<button role="checkbox">`, `<div role="option">`)
3. Generated locators by ad-hoc CSS path construction without confidence ranking
4. Did not compute accessible names per the W3C Accname specification
5. Lacked portal/overlay context awareness (e.g., dropdown options that should reference their trigger)

---

## Changes Made

### 1. HTML Element Rules Engine (`element-rules-engine.ts` — NEW, 700 lines)

A self-contained browser-injectable engine organized into 10 sections:

| Section                           | Purpose                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §1 `resolveRole` / `classifyRole` | Maps elements to ARIA roles via HTML-AAM implicit mappings + explicit `role` attributes. Categorizes into: actionable, input, toggle, select, option, navigation, container, display |
| §2 `resolveInteractiveElement`    | DOM walk from any event target (nested span, SVG icon) up to the nearest semantically meaningful interactive ancestor                                                                |
| §3 `getAccessibleName`            | Computes accessible names per W3C Accname 1.2: `aria-labelledby` → `aria-label` → `<label>` → `title` → `placeholder` → text content                                                 |
| §4 `resolveOwningContext`         | Detects portal containers (menu, listbox, dialog, alertdialog) and resolves trigger labels for dropdown/select options                                                               |
| §5 `generateLocators`             | Generates up to 8 locator strategies ranked by confidence: id (0.99), name (0.95), aria (0.9), linkText (0.85), text (0.6), data-testid (0.8), css (0.4), xpath (0.3)                |
| §6 `extractInputValue`            | Extracts values from inputs, selects, textareas, contenteditable, and ARIA-checked elements. Obscures passwords as `********`                                                        |
| §7 `extractLabel`                 | Form field label heuristics: accessible name → `<label>` → preceding text → table column headers → placeholder                                                                       |
| §8 `describeAction`               | Generates human-readable descriptions: "Clicked button 'Submit'", "Typed 'admin' into 'Username'", "Selected 'Orange' from 'Fruit' list"                                             |
| §9 `inspectElement`               | Master entry point composing all sub-functions into a single inspection result                                                                                                       |
| §10 `window.__webcure`            | Public API surface exposed as a global for injection                                                                                                                                 |

**Key design decisions:**

- Pure vanilla JS — no Playwright, React, or framework dependency
- Exported via `getEngineScript()` as a self-contained string (27,568 chars) for `addInitScript()` or `page.evaluate()` injection
- All role-to-category mappings follow W3C HTML-AAM and WAI-ARIA specifications

### 2. Step Recorder Integration (`step-recorder.ts` — 616→393 lines)

Replaced all inline element identification with `import { getEngineScript }`. The recorder now:

- Injects the engine via `addInitScript(getEngineScript())`
- Calls `window.__webcure.inspectElement(el, action, extras)` for all event handling
- Calls `window.__webcure.resolveInteractiveElement(target)` for input resolution
- Reduced from 616 to 393 lines (36% reduction)

### 3. Engine Bug Fixes Discovered During Live Testing

| Bug                                                                                    | Fix                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `tabpanel` role returned `generic` category                                            | Added `tabpanel: 'container'` to `ROLE_CATEGORY` map          |
| ARIA checkboxes (`<button role="checkbox" aria-checked="true">`) returned `null` value | Added `aria-checked` attribute check in `extractInputValue()` |

### 4. Test Infrastructure

**TypeScript unit tests** (`tests/unit/element-rules-engine.test.ts`):

- 113 tests across 12 sections (§1-§11 plus §1b)
- Uses `playwright-core` with cached Chromium binaries
- Injects engine into real browser pages with synthetic HTML
- Run via: `npx tsx tests/unit/element-rules-engine.test.ts`

**Python live browser integration tests** (`tests/integration/live_engine_test.py`):

- 63 tests across 31 sections against 4 real websites
- Uses Python `playwright` package with system Chromium
- Captures 13 screenshots during test run
- Run via: `python3 tests/integration/live_engine_test.py`

### 5. TypeScript Configuration Fixes

- Added `"DOM"` to `tests/tsconfig.json` `lib` array — fixed 37 VS Code errors for browser globals (`document`, `window`) inside `page.evaluate()` callbacks
- Removed stale `live-engine-test.ts` (old TypeScript integration test replaced by Python version) — eliminated 53 compilation errors
- Result: **0 problems** in VS Code Problems tab

### 6. README Updates

- Added **Test Dependencies** section with install commands for both TS and Python test stacks
- Added **Running Tests** section with all 4 test commands
- Updated project structure to include new test files

---

## Files Changed

| File                                      | Type     | Changes                                                                      |
| ----------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `src/recorder/element-rules-engine.ts`    | **New**  | 700-line standards-based element rules engine (10 sections, pure browser JS) |
| `src/recorder/step-recorder.ts`           | Modified | Replaced inline logic with engine calls (616→393 lines, 36% reduction)       |
| `tests/unit/element-rules-engine.test.ts` | **New**  | 113 TypeScript unit tests across 12 sections                                 |
| `tests/integration/live_engine_test.py`   | **New**  | 63 Python live browser integration tests against 4 real websites             |
| `tests/tsconfig.json`                     | Modified | Added `"DOM"` to lib array                                                   |
| `tsconfig.json`                           | Modified | Cleaned up stale exclude entry                                               |
| `README.md`                               | Modified | Added Test Dependencies, Running Tests sections; updated project structure   |
| `status/project_status_07.md`             | **New**  | This file                                                                    |

---

## Test Results

### Unit Tests — Element Rules Engine (113 tests)

| Section                                             | Tests   | Result       |
| --------------------------------------------------- | ------- | ------------ |
| §1 Element Classification — Implicit HTML-AAM Roles | 20      | PASS         |
| §1b Element Classification — Explicit ARIA Roles    | 7       | PASS         |
| §2 Interactive Element Resolution                   | 8       | PASS         |
| §3 Accessible Name Computation                      | 12      | PASS         |
| §4 Context Resolution — Dropdowns, Menus, Dialogs   | 7       | PASS         |
| §5 Locator Generation — Multi-Strategy              | 12      | PASS         |
| §6 Input Value Extraction                           | 7       | PASS         |
| §7 Label Extraction — Form Field Heuristics         | 9       | PASS         |
| §8 Action Descriptions                              | 11      | PASS         |
| §9 inspectElement — Full Integration                | 4       | PASS         |
| §10 Portal-Based Component Patterns                 | 10      | PASS         |
| §11 Edge Cases & Robustness                         | 6       | PASS         |
| **Total**                                           | **113** | **ALL PASS** |

### Live Browser Integration Tests — Python (63 tests)

| Site / Section                                   | Tests  | Result       |
| ------------------------------------------------ | ------ | ------------ |
| Site 1: demo.testfire.net — Navigation & Links   | 3      | PASS         |
| Site 1: demo.testfire.net — Login Form           | 6      | PASS         |
| Site 2: herokuapp — Checkboxes                   | 2      | PASS         |
| Site 2: herokuapp — Native `<select>` Dropdown   | 3      | PASS         |
| Site 2: herokuapp — Number Input                 | 2      | PASS         |
| Site 2: herokuapp — Key Presses                  | 2      | PASS         |
| Site 2: herokuapp — Links with linkText Locators | 2      | PASS         |
| Site 2: herokuapp — Tables                       | 2      | PASS         |
| Site 2: herokuapp — Dynamic Elements             | 3      | PASS         |
| Site 2: herokuapp — Headings                     | 2      | PASS         |
| Site 3: Radix UI — Page Load & Buttons           | 2      | PASS         |
| Site 3: Radix UI — Select Component              | 2      | PASS         |
| Site 3: Radix UI — Dropdown Menu                 | 1      | PASS         |
| Site 3: Radix UI — Tabs                          | 1      | PASS         |
| Site 3: Radix UI — Nested Element Resolution     | 2      | PASS         |
| Site 3: Radix UI — Checkboxes                    | 3      | PASS         |
| Site 3: Radix UI — Radio Buttons                 | 2      | PASS         |
| Site 3: Radix UI — Text Fields & Text Areas      | 3      | PASS         |
| Site 3: Radix UI — Switch                        | 1      | PASS         |
| Site 3: Radix UI — Slider                        | 1      | PASS         |
| Site 3: Radix UI — Links & Navigation            | 2      | PASS         |
| Site 3: Radix UI — Headings                      | 1      | PASS         |
| Site 3: Radix UI — Disabled Elements             | 1      | PASS         |
| Site 3: Radix UI — Alert Dialog (Portal)         | 1      | PASS         |
| Site 3: Radix UI — Progress Bar                  | 1      | PASS         |
| Site 3: Radix UI — Tabpanel                      | 1      | PASS         |
| Site 3: Radix UI — Separator & Display Elements  | 2      | PASS         |
| Site 3: Radix UI — Locator Quality               | 2      | PASS         |
| Site 3: Radix UI — Accessible Name Computation   | 2      | PASS         |
| Site 3: Radix UI — Table Structures              | 2      | PASS         |
| Site 4: W3C WAI-ARIA — Tabs Example              | 3      | PASS         |
| **Total**                                        | **63** | **ALL PASS** |

### Radix UI Themes Playground Coverage

The Radix playground (`https://www.radix-ui.com/themes/playground`) proved to be the most valuable test site, exercising the following engine capabilities:

| Engine Capability                     | Radix Component Tested                                          |
| ------------------------------------- | --------------------------------------------------------------- |
| Role classification (button)          | Button, Icon Button, Alert Dialog triggers                      |
| Role classification (checkbox)        | Checkbox, Checkbox Group, Checkbox Cards                        |
| Role classification (radio)           | Radio, Radio Group, Radio Cards                                 |
| Role classification (combobox/option) | Select component (portal-based)                                 |
| Role classification (menuitem)        | Dropdown Menu                                                   |
| Role classification (tab/tabpanel)    | Tabs, Tab Nav                                                   |
| Role classification (switch)          | Switch                                                          |
| Role classification (slider)          | Slider                                                          |
| Role classification (textbox)         | Text Field, Text Area                                           |
| Role classification (link)            | Links, navigation, "View in docs"                               |
| Role classification (heading)         | All component section headings                                  |
| Role classification (img)             | Avatar, Aspect Ratio images                                     |
| Role classification (progressbar)     | Progress                                                        |
| Role classification (alertdialog)     | Alert Dialog portal                                             |
| Interactive element resolution        | SVG icons inside buttons, spans inside links                    |
| Accessible name computation           | aria-label checkboxes, placeholder inputs, labeled fields       |
| Portal context resolution             | Select options → listbox trigger, Menu items → dropdown trigger |
| Locator generation                    | Multiple strategies with confidence ranking                     |
| Disabled element handling             | Disabled buttons correctly identified                           |
| Value extraction (aria-checked)       | ARIA checkboxes and switches                                    |

---

## Known Limitations

1. **Scroll-dependent elements**: Some Radix components (e.g., Segmented Control, Popover, Tooltip) may not be visible without scrolling — live tests only cover above-the-fold or triggered elements
2. **Context Menu**: Requires right-click interaction which the test framework doesn't trigger
3. **Hover Card**: Requires hover state which headless Chromium handles inconsistently
4. **`table` category**: Tables are classified as `generic` rather than a dedicated category — acceptable since tables are structural containers, not interactive elements

---

## Next Steps

1. Add scroll-and-test capability to cover below-fold components (Popover, Segmented Control, Tooltip)
2. Consider adding `table` as a dedicated category if needed for step recorder descriptions
3. Context menu right-click testing
4. Performance benchmarks for engine injection + inspection on large DOM trees
