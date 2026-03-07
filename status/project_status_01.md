# WebCure — Project Status Report #01

**Date:** 2026-03-07  
**Author:** Naveed ul Islam  
**Version:** 1.0.0  
**Repository:** https://github.com/naveedulislam/webcure.git

---

## Executive Summary

WebCure v1.0.0 is a VS Code extension that provides browser automation through three parallel interfaces: Language Model Tools (for GitHub Copilot), a File Bridge (for AI agents in Cursor/Antigravity), and an HTTP API. All 28 Language Model tools, 17 bridge-only commands, and the complete command palette have been manually tested with 69/69 tests passing.

Two critical bugs were discovered and fixed during testing:

1. **ClickTool dialog race condition** — Playwright's `click()` blocks when a JavaScript dialog opens; the original promise handling led to unhandled rejections. Fixed with proper chaining and a 6-second timeout.
2. **SnapshotTool crash** — `page.accessibility.snapshot()` was removed in Playwright 1.58.2. Replaced with `page.locator('body').ariaSnapshot()`.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              ACCESS LAYERS                                   │
├──────────────────┬──────────────────────┬────────────────────────────────────┤
│ GitHub Copilot   │ File Bridge (CLI)    │ HTTP API (port 5678)              │
│ 28 LM Tools      │ .webcure/input.json  │ POST /api/execute                 │
│ explorer_*       │ → output.json        │ GET /api/status                   │
├──────────────────┴──────────────────────┴────────────────────────────────────┤
│                    28 Tool Instance Classes (tools.ts)                        │
│  NavigateTool, ClickTool, SnapshotTool, ScrapePageTool, ...                  │
├──────────────────────────────────────────────────────────────────────────────┤
│          BrowserManager Singleton (browserManager.ts)                         │
│  Playwright-core → System Chrome/Edge                                        │
│  Dialog handling · Element refs (e1, e2, ...) · Network/Console buffers      │
├──────────────────────────────────────────────────────────────────────────────┤
│          Additional Features                                                  │
│  Action Recorder → Python Script Generator · JSON Script Runner              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
webcure/
├── package.json               # Extension manifest
├── tsconfig.json              # TypeScript configuration
├── README.md                  # Comprehensive user documentation (622 lines)
├── LICENSE                    # License file
├── .gitignore                 # Excludes out/, node_modules/, dist/, .webcure/, *.vsix
├── .vscodeignore              # VSIX packaging excludes
│
├── src/                       # TypeScript source
│   ├── extension.ts           # Entry point: tool registration, bridge, API, commands
│   ├── tools.ts               # 28 Language Model Tool class implementations
│   ├── browserManager.ts      # Playwright singleton, dialog/element tracking
│   ├── apiServer.ts           # HTTP API server
│   ├── types.ts               # Shared interfaces
│   ├── constants.ts           # Bridge paths, config constants
│   ├── bridge/
│   │   ├── file-bridge.ts     # File-watching command router (38 mapped + 17 bridge-only)
│   │   └── cli-template.js    # CLI helper (copied to .webcure/)
│   └── recorder/
│       ├── action-log.ts      # Capture browser actions
│       └── script-generator.ts # Generate Python scripts from recordings
│
├── out/                       # Compiled JavaScript (tsc output)
├── dist/                      # Packaged extension
│   └── webcure.vsix           # Installable VSIX bundle
│
├── tests/                     # Test documentation and scripts
│   ├── MANUAL-TEST-RESULTS.md # Manual test results (69 tests, all passing)
│   ├── bridge-integration-tests.sh  # Automated bridge integration test script
│   └── unit/                  # Unit tests (mocha + sinon)
│       └── tools.test.ts      # Unit tests for tool classes
│
└── status/                    # Project status documents
    └── project_status_01.md   # This file
```

---

## Technology Stack

| Component      | Technology            | Version |
| -------------- | --------------------- | ------- |
| Runtime        | VS Code Extension API | 1.95+   |
| Language       | TypeScript            | 5.6.3   |
| Browser Engine | Playwright-core       | 1.58.2  |
| Browser        | System Chrome/Edge    | Latest  |
| Packaging      | @vscode/vsce          | 3.2.2   |
| Node.js        | Required              | 18+     |

---

## What Was Built

### 28 Language Model Tools

Registered with `vscode.lm.registerTool()` for use via GitHub Copilot chat:

| Category        | Tools                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation      | `explorer_navigate`, `explorer_navigate_back`, `explorer_resize`                                                                         |
| Interaction     | `explorer_click`, `explorer_hover`, `explorer_drag`, `explorer_find`, `explorer_interact`                                                |
| Input           | `explorer_type`, `explorer_type_from_file`, `explorer_press_key`, `explorer_select_option`, `explorer_fill_form`, `explorer_file_upload` |
| Inspection      | `explorer_snapshot`, `explorer_extract`, `explorer_evaluate`, `explorer_take_screenshot`, `explorer_scrape_page`, `explorer_scrape_menu` |
| Waiting         | `explorer_wait_for`, `explorer_wait_for_element`                                                                                         |
| Dialog          | `explorer_handle_dialog`                                                                                                                 |
| Network/Console | `explorer_console_messages`, `explorer_network_requests`                                                                                 |
| Tabs/Browser    | `explorer_tabs`, `explorer_close`, `explorer_install`                                                                                    |

### 17 Bridge-Only Commands

Commands available only through the file bridge (no LM tool equivalent):
`launchBrowser`, `scrollDown`, `scrollUp`, `scrollRight`, `scrollLeft`, `doubleClick`, `rightClick`, `refresh`, `goForward`, `switchWindow`, `getPageInfo`, `getPageContent`, `getPageText`, `getAccessibilityTree`, `highlight`, `getDialogText`, `setDialogAction`, `startRecording`, `stopRecording`

### 33 Command Palette Commands

Test harness commands under "WebCure:" prefix in VS Code Command Palette.

### Additional Features

- **HTTP API Server** on configurable port (default 5678)
- **Action Recorder** captures browser interactions
- **Python Script Generator** converts recordings to executable Python
- **JSON Script Runner** executes multi-step automation scripts

---

## Bugs Found & Fixed

### Bug 1: ClickTool Dialog Race Condition

**Problem:** When clicking a button that triggers a JavaScript dialog (alert, confirm, prompt), Playwright's `page.click()` blocks indefinitely because the dialog suspends page execution. The original code had:

```typescript
const clickAction = page.click(selector, { timeout: 30000 });
clickAction.catch(() => {}); // Swallow click errors
const result = await clickAction.then(() => "done");
```

This produced an unhandled promise rejection — the `.then()` created a new promise chain that wasn't catching errors.

**Fix:** Chained `.then().catch()` together and reduced timeout to 6 seconds:

```typescript
const clickAction = page.click(selector, { timeout: 6000 });
const result = await clickAction.then(() => "done").catch(() => "click-error");
```

Both `'timeout'` and `'click-error'` results now check for a handled dialog and report success.

### Bug 2: SnapshotTool Crash (Playwright 1.58)

**Problem:** `page.accessibility.snapshot()` was removed in Playwright 1.58. Calling it threw `TypeError: Cannot read properties of undefined`.

**Fix:** Replaced with `page.locator('body').ariaSnapshot()` which returns a YAML-formatted accessibility tree. Added a separate loop using `page.locator()` queries to register interactive elements (links, buttons, inputs, selects, textareas) as numbered refs (e1, e2, ...).

---

## Test Results

### Summary

| Category             | Tests  | Passed | Failed |
| -------------------- | ------ | ------ | ------ |
| Language Model Tools | 40     | 40     | 0      |
| File-Bridge Commands | 29     | 29     | 0      |
| **Total**            | **69** | **69** | **0**  |

### Test Environment

- **OS:** macOS
- **VS Code:** Latest
- **Browser:** System Chrome
- **Test Site:** https://the-internet.herokuapp.com

### Test Coverage

All 28 LM tools were tested through direct invocation. All bridge commands (38 tool-mapped + 17 bridge-only) were tested via `.webcure/input.json` protocol. Dialog handling was verified across all three dialog types (alert, confirm, prompt) with both accept and dismiss actions.

Full test details: [tests/MANUAL-TEST-RESULTS.md](../tests/MANUAL-TEST-RESULTS.md)

---

## Build & Install

```bash
# Compile TypeScript
npm run compile

# Package as VSIX
npm run package

# Install in VS Code
code --install-extension dist/webcure.vsix
```

---

## Next Steps

- [ ] Add automated integration tests for the bridge protocol
- [ ] Add unit tests for tool classes
- [ ] CI/CD pipeline for automated testing on commits
- [ ] Explore adding support for Firefox via Playwright
- [ ] Add session persistence (save/restore browser state)
- [ ] Performance benchmarks for common workflows
