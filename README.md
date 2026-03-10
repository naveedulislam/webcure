# WebCure

Browser automation for AI agents and developers. Search the web, test browser-based applications, and record automation scripts — all from your editor.

WebCure is a **hybrid** VS Code extension that combines two separate browser automation approaches into one package:

1. **Language Model Tools** — 28 tools registered with VS Code's `vscode.lm.registerTool()` API so GitHub Copilot can control the browser directly in chat.
2. **File Bridge + CLI** — A file-based protocol (`.webcure/input.json` → `output.json`) with a CLI wrapper so AI agents in **Cursor**, **Antigravity**, or any terminal-capable IDE can control the same browser engine via shell commands.

Both approaches share the same Playwright-based browser engine. Whether Copilot invokes `explorer_navigate` or a Cursor agent runs `node .webcure/cli.js navigate url=...`, the same underlying code executes.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Installation (Step by Step)](#installation-step-by-step)
- [Quick Start: VS Code Copilot (Language Model Tools)](#quick-start-vs-code-copilot-language-model-tools)
- [Quick Start: Cursor / AI Agents (File Bridge + CLI)](#quick-start-cursor--ai-agents-file-bridge--cli)
- [Language Model Tools Reference](#language-model-tools-reference)
- [File Bridge Commands Reference](#file-bridge-commands-reference)
- [How LM Tools and Bridge Commands Relate](#how-lm-tools-and-bridge-commands-relate)
- [VS Code Commands (Command Palette)](#vs-code-commands-command-palette)
- [HTTP API Server](#http-api-server)
- [Step Recording (Automatic Documentation)](#step-recording-automatic-documentation)
- [Script Recording & Python Playback](#script-recording--python-playback)
- [JSON Script Runner](#json-script-runner)
- [Configuration](#configuration)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         WebCure Extension                        │
│                                                                  │
│  ┌────────────────────┐   ┌────────────────────┐                │
│  │ Language Model Tools│   │ File Bridge + CLI   │                │
│  │ (VS Code Copilot)  │   │ (Cursor / Agents)   │                │
│  │                    │   │                    │                │
│  │ 28 explorer_* tools│   │ .webcure/input.json │                │
│  │ registered via     │   │ .webcure/output.json│                │
│  │ vscode.lm API      │   │ .webcure/cli.js     │                │
│  └────────┬───────────┘   └────────┬───────────┘                │
│           │                        │                             │
│           ▼                        ▼                             │
│  ┌──────────────────────────────────────────┐                   │
│  │      Shared Tool Instances (28 tools)    │                   │
│  └──────────────────┬───────────────────────┘                   │
│                     │                                            │
│                     ▼                                            │
│  ┌──────────────────────────────────────────┐                   │
│  │      BrowserManager (Playwright-core)    │                   │
│  │      Uses system Chrome or Edge          │                   │
│  └──────────────────────────────────────────┘                   │
│                                                                  │
│  ┌────────────────┐  ┌──────────────────────┐  ┌──────────────┐  │
│  │  HTTP API Server│  │  Action Recorder     │  │ Step Recorder│  │
│  │  (port 5678)    │  │  + Python Generator  │  │ (Markdown +  │  │
│  └────────────────┘  └──────────────────────┘  │  Screenshots)│  │
│                                                 └──────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Key points:**

- The 28 Language Model Tool classes are the core engine. They implement `vscode.LanguageModelTool`.
- The file bridge maps its ~60 command names to those same 28 tool instances (plus ~17 bridge-only commands for scrolling, recording, etc.).
- Commands like `scrollDown`, `doubleClick`, `rightClick`, `launchBrowser`, `getPageText`, `highlight` exist **only** in the file bridge — they have no LM tool equivalent because they are simple Playwright calls that don't need the full tool infrastructure.
- The HTTP API server provides a third access path to the same tools via `POST /invoke`.

---

## Prerequisites

- **Node.js 18+** — check with `node --version`
- **npm** — comes with Node.js
- **Google Chrome or Microsoft Edge** — WebCure uses `playwright-core` which connects to your system browser (it does **not** download Chromium automatically)
- **VS Code 1.95+** — for Language Model Tools support (requires Copilot)

---

## Installation (Step by Step)

### Step 1: Get the source code

```bash
cd ~/Developer
git clone https://github.com/naveedulislam/webcure.git webcure
```

Or if you already have the source:

```bash
cd ~/Developer/webcure
```

### Step 2: Install dependencies

```bash
npm install
```

### Step 3: Compile the TypeScript

```bash
npm run compile
```

This runs `tsc` and outputs JavaScript to the `out/` directory.

### Step 4: Package into a .vsix file

```bash
npm run package
```

This produces `dist/webcure.vsix`. The file is the installable extension.

### Step 5: Install in your editor

**VS Code (command line):**

```bash
code --install-extension dist/webcure.vsix
```

**VS Code (graphical):**

1. Open VS Code
2. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
3. Type **Extensions: Install from VSIX...**
4. Navigate to `~/Developer/webcure/dist/`
5. Select `webcure.vsix`
6. Restart VS Code when prompted

**Cursor (command line):**

```bash
cursor --install-extension dist/webcure.vsix
```

**Cursor (graphical):**

1. Open Cursor
2. Press `Cmd+Shift+P`
3. Type **Extensions: Install from VSIX...**
4. Select `webcure.vsix`
5. Restart Cursor

### Step 6: Verify the installation

1. Open the Command Palette: `Cmd+Shift+P`
2. Type **WebCure**
3. You should see all WebCure commands listed (Navigate to URL, Click Element, etc.)

---

## Quick Start: VS Code Copilot (Language Model Tools)

Once the extension is installed and VS Code has restarted, the 28 `explorer_*` tools are automatically registered with VS Code's Language Model API. GitHub Copilot can use them directly in chat.

**Example conversation:**

> **You:** Navigate to https://example.com and take a screenshot  
> **Copilot:** _(uses `explorer_navigate` then `explorer_take_screenshot` automatically)_  
> Done — screenshot saved to `screenshot.png`

> **You:** Find the login form data, fill in the email and password fields  
> **Copilot:** _(uses `explorer_snapshot`, `explorer_fill_form`)_

You can also reference tools explicitly by typing `#` in chat:

```
#explorer_navigate to https://news.ycombinator.com
#explorer_snapshot to see the page structure
#explorer_click on "new" link
```

**No configuration required.** The tools are available as soon as the extension activates (`onStartupFinished`).

---

## Quick Start: Cursor / AI Agents (File Bridge + CLI)

When the extension activates, it creates a `.webcure/` directory in your workspace root containing:

- `cli.js` — CLI helper that writes `input.json` and polls for `output.json`
- `input.json` — Written by the agent, read by the extension
- `output.json` — Written by the extension, read by the agent

### How It Works

1. Agent runs: `node .webcure/cli.js navigate url=https://example.com`
2. `cli.js` writes `{"command": "navigate", "args": {"url": "https://example.com"}}` to `.webcure/input.json`
3. The extension detects the file via `fs.watch`, executes the command, writes the result to `.webcure/output.json`, and deletes `input.json`
4. `cli.js` polls for `output.json`, reads it, prints the result, and deletes it

### CLI Examples

```bash
# Launch a browser and navigate
node .webcure/cli.js launchBrowser url=https://example.com

# Click by visible text
node .webcure/cli.js click target="Sign In"

# Click with spatial targeting (click "Edit" below "Profile")
node .webcure/cli.js click target="Edit" below="Profile"

# Type into a field
node .webcure/cli.js typeText text="hello" into="Search"

# Take an accessibility snapshot (assigns refs e1, e2, ...)
node .webcure/cli.js snapshot

# Find an element (returns a ref for later use)
node .webcure/cli.js find text="Submit"

# Interact using a ref from snapshot or find
node .webcure/cli.js interact action=click ref=e3

# Fill a form using refs
node .webcure/cli.js fillForm 'fields=[{"name":"Email","type":"textbox","ref":"e3","value":"test@example.com"}]'

# Scroll the page
node .webcure/cli.js scrollDown pixels=500

# Take a screenshot
node .webcure/cli.js screenshot filename=result.png

# Get page text content
node .webcure/cli.js getPageText

# Scrape menu structure
node .webcure/cli.js scrapeMenu

# Scrape page structure (forms, tables)
node .webcure/cli.js scrapePage

# Close the browser
node .webcure/cli.js closeBrowser

# See all available commands
node .webcure/cli.js help
```

### Can LM Tools Be Used Through input.json?

**Yes.** The file bridge routes commands to the same 28 tool instances that Copilot uses. When you run `node .webcure/cli.js navigate url=...`, the bridge internally calls `NavigateTool.invoke()` — the exact same code path as when Copilot uses `explorer_navigate`. The bridge command names are just friendlier aliases (e.g., `navigate` instead of `explorer_navigate`, `click` instead of `explorer_click`).

---

## Language Model Tools Reference

These 28 tools are registered with VS Code's `vscode.lm.registerTool()` API. Copilot invokes them automatically based on user requests.

| Tool Name                   | Display Name           | Description                                                            |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `explorer_navigate`         | Navigate to URL        | Open a URL in the browser                                              |
| `explorer_resize`           | Resize Window          | Resize viewport (preset `fullscreen` or custom width/height)           |
| `explorer_extract`          | Extract Content        | Extract visible text from the page or a CSS selector                   |
| `explorer_click`            | Click Element          | Click by ref, text, or selector with spatial targeting                 |
| `explorer_hover`            | Hover Element          | Hover over an element                                                  |
| `explorer_type`             | Type Text              | Type into an input field                                               |
| `explorer_type_from_file`   | Type Text from File    | Type large text content from a file into an input                      |
| `explorer_wait_for`         | Wait For               | Wait for text to appear/disappear or a fixed time                      |
| `explorer_wait_for_element` | Wait For Element       | Wait for an element to be visible/hidden/attached/detached             |
| `explorer_select_option`    | Select Option          | Pick a value from a dropdown                                           |
| `explorer_fill_form`        | Fill Form              | Fill multiple form fields using refs from snapshot                     |
| `explorer_take_screenshot`  | Take Screenshot        | Capture screenshot (full page or specific element)                     |
| `explorer_close`            | Close Browser          | Close the page and release resources                                   |
| `explorer_console_messages` | Get Console Messages   | Return recent browser console messages                                 |
| `explorer_drag`             | Drag And Drop          | Drag from one element to another using refs                            |
| `explorer_evaluate`         | Evaluate Script        | Run JavaScript in the page context                                     |
| `explorer_file_upload`      | Upload File            | Upload files via file input or file chooser                            |
| `explorer_handle_dialog`    | Handle Dialog          | Accept or dismiss alert/confirm/prompt dialogs                         |
| `explorer_navigate_back`    | Navigate Back          | Go back in browser history                                             |
| `explorer_network_requests` | Get Network Requests   | Return observed network requests                                       |
| `explorer_press_key`        | Press Key              | Press a keyboard key (Enter, Tab, etc.)                                |
| `explorer_snapshot`         | Accessibility Snapshot | Capture accessibility tree with element refs (e1, e2, ...)             |
| `explorer_tabs`             | Manage Tabs            | List, create, close, or select browser tabs                            |
| `explorer_install`          | Install Browser        | No-op (uses system Chrome/Edge)                                        |
| `explorer_find`             | Find Element           | Find elements by text, position, or selector — returns a ref           |
| `explorer_interact`         | Interact with Element  | Multi-action: click, type, hover, clear, select, focus, check, uncheck |
| `explorer_scrape_menu`      | Scrape Menu Structure  | Extract hierarchical navigation menus as JSON                          |
| `explorer_scrape_page`      | Scrape Page Content    | Extract forms, tables, and filters as structured JSON                  |

---

## File Bridge Commands Reference

The file bridge accepts all of the above tool commands (by alias) **plus** additional bridge-only commands:

### Commands That Map to LM Tools

These bridge commands invoke the same tool code as the LM tools:

| Bridge Command      | Maps To LM Tool                | Notes                                       |
| ------------------- | ------------------------------ | ------------------------------------------- |
| `navigate`          | `explorer_navigate`            | `url` arg (or `target` as alias)            |
| `click`             | `explorer_click`               | `target` arg maps to `text`                 |
| `hover`             | `explorer_hover`               | Same spatial targeting (above, below, etc.) |
| `typeText`          | `explorer_type`                | `into` arg maps to field identifier         |
| `typeFromFile`      | `explorer_type_from_file`      |                                             |
| `pressKey`          | `explorer_press_key`           | `key` or `target` arg                       |
| `selectOption`      | `explorer_select_option`       | `comboBox` + `value` args                   |
| `fillForm`          | `explorer_fill_form`           |                                             |
| `screenshot`        | `explorer_take_screenshot`     | `filename` or `outputPath` args             |
| `consoleMessages`   | `explorer_console_messages`    |                                             |
| `networkRequests`   | `explorer_network_requests`    |                                             |
| `handleDialog`      | `explorer_handle_dialog`       |                                             |
| `uploadFile`        | `explorer_file_upload`         |                                             |
| `evaluate`          | `explorer_evaluate`            | `expression` arg maps to `function`         |
| `navigateBack`      | `explorer_navigate_back`       |                                             |
| `goBack`            | `explorer_navigate_back`       | Alias for `navigateBack`                    |
| `snapshot`          | `explorer_snapshot`            |                                             |
| `find`              | `explorer_find`                |                                             |
| `interact`          | `explorer_interact`            |                                             |
| `scrapeMenu`        | `explorer_scrape_menu`         |                                             |
| `scrapePage`        | `explorer_scrape_page`         |                                             |
| `drag` / `dragTo`   | `explorer_drag`                | `source` + `target` args                    |
| `close`             | `explorer_close`               |                                             |
| `closeBrowser`      | `explorer_close`               | Alias                                       |
| `tabs`              | `explorer_tabs`                |                                             |
| `listTabs`          | `explorer_tabs` (list)         |                                             |
| `newTab`            | `explorer_tabs` (new)          |                                             |
| `closeTab`          | `explorer_tabs` (close)        |                                             |
| `selectTab`         | `explorer_tabs` (select)       |                                             |
| `waitForText`       | `explorer_wait_for`            |                                             |
| `waitForElement`    | `explorer_wait_for_element`    |                                             |
| `wait`              | `explorer_wait_for`            | `ms` or `time` arg                          |
| `resize`            | `explorer_resize`              |                                             |
| `resizeBrowser`     | `explorer_resize`              | Alias                                       |
| `fullscreenBrowser` | `explorer_resize` (fullscreen) |                                             |
| `extract`           | `explorer_extract`             |                                             |

### Bridge-Only Commands (No LM Tool Equivalent)

These commands exist only in the file bridge and are implemented directly against `BrowserManager` / Playwright:

| Bridge Command         | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `launchBrowser`        | Open a browser window (optionally navigate to a URL)       |
| `scrollDown`           | Scroll down (default 500px, configurable via `pixels` arg) |
| `scrollUp`             | Scroll up                                                  |
| `scrollRight`          | Scroll right (default 300px)                               |
| `scrollLeft`           | Scroll left                                                |
| `doubleClick`          | Double-click an element by text or ref                     |
| `rightClick`           | Right-click an element by text or ref                      |
| `refresh`              | Reload the current page                                    |
| `goForward`            | Go forward in browser history                              |
| `switchWindow`         | Switch to a tab by title match                             |
| `getPageInfo`          | Get current URL and page title                             |
| `getPageContent`       | Get raw HTML content (truncated to 50KB)                   |
| `getPageText`          | Get visible text content (truncated to 50KB)               |
| `getAccessibilityTree` | Get accessibility tree (delegates to snapshot tool)        |
| `highlight`            | Visually outline an element on the page                    |
| `getDialogText`        | Get text from the current dialog                           |
| `startRecording`       | Begin recording actions                                    |
| `stopRecording`        | Stop recording and return generated Python script          |
| `runScript`            | Execute a JSON automation script                           |

---

## How LM Tools and Bridge Commands Relate

**Are the commands duplicated?**

No. There is one set of 28 tool classes (in `tools.ts`). The LM tool registration and the bridge both point to the same instances:

- **LM Path:** Copilot → `vscode.lm.registerTool('explorer_navigate', NavigateTool)` → `NavigateTool.invoke()`
- **Bridge Path:** CLI → `input.json` → bridge → `BRIDGE_TO_TOOL['navigate'] → toolInstances.navigate.invoke()`

The bridge adds **convenience aliases** (e.g., `goBack` → `navigateBack`, `closeBrowser` → `close`) and **bridge-only commands** (scrolling, page info, recording) that don't need the full LM tool interface.

The 33 VS Code commands in the Command Palette (e.g., `webcure.testNavigate`) are **test harnesses** — they prompt for input via `vscode.window.showInputBox` and invoke the same tool instances, displaying results in the Output panel. They are useful for manual testing without Copilot or the CLI.

---

## VS Code Commands (Command Palette)

All commands are accessible via `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Windows/Linux) under the **WebCure** category:

| Command                           | What it does                                    |
| --------------------------------- | ----------------------------------------------- |
| WebCure: Navigate to URL          | Prompts for a URL and navigates                 |
| WebCure: Click Element            | Prompts for text/selector and clicks            |
| WebCure: Hover Element            | Hover over an element                           |
| WebCure: Type Text                | Type into a field                               |
| WebCure: Type Text from File      | Type file contents into a field                 |
| WebCure: Press Key                | Press a keyboard key                            |
| WebCure: Take Screenshot          | Save a screenshot                               |
| WebCure: Take Snapshot            | Capture accessibility tree with refs            |
| WebCure: Find Element             | Find element by text/selector                   |
| WebCure: Interact with Element    | Multi-action on an element by ref               |
| WebCure: Select Option            | Pick a dropdown value                           |
| WebCure: Fill Form                | Fill multiple form fields                       |
| WebCure: Drag Element             | Drag and drop                                   |
| WebCure: Evaluate JavaScript      | Run JS in page context                          |
| WebCure: Extract Text Content     | Extract visible text                            |
| WebCure: Wait For Text            | Wait for text on page                           |
| WebCure: Wait For Element         | Wait for element state                          |
| WebCure: Resize Browser Window    | Resize viewport                                 |
| WebCure: Navigate Back            | Go back in history                              |
| WebCure: Manage Tabs              | List/create/close/select tabs                   |
| WebCure: Close Browser            | Close the browser                               |
| WebCure: Get Console Messages     | Show browser console output                     |
| WebCure: Get Network Requests     | Show observed network requests                  |
| WebCure: Handle Dialog            | Accept/dismiss a dialog                         |
| WebCure: Upload File              | Upload files                                    |
| WebCure: Scrape Menu/Navigation   | Extract menu structure                          |
| WebCure: Scrape Page Structure    | Extract forms/tables                            |
| WebCure: Tools Menu               | Quick-pick menu of all tools                    |
| WebCure: Start API Server         | Start the HTTP API on port 5678                 |
| WebCure: Stop API Server          | Stop the HTTP API                               |
| WebCure: Start Recording          | Begin recording browser actions                 |
| WebCure: Stop Recording           | Stop and generate Python script                 |
| WebCure: Record Steps (Automatic) | Start automatic step recording with screenshots |
| WebCure: Stop Recording Steps     | Stop step recording and open the Markdown log   |
| WebCure: Run Script               | Execute a JSON automation script                |

---

## HTTP API Server

WebCure includes an HTTP API server for programmatic access from external scripts or tools.

**Enable via settings** (`webcure.api.enabled: true`) or start manually:

- `Cmd+Shift+P` → **WebCure: Start API Server**

**Endpoints:**

```bash
# Invoke any command
curl -X POST http://localhost:5678/invoke \
  -H "Content-Type: application/json" \
  -d '{"command": "navigate", "args": {"url": "https://example.com"}}'

# List available tools
curl http://localhost:5678/tools

# Health check
curl http://localhost:5678/health
```

---

## Step Recording (Automatic Documentation)

WebCure can automatically record every user interaction in the browser and produce a **Markdown document** with plain-English descriptions and a screenshot for each step. This is useful for creating test documentation, bug reports, or onboarding guides without any manual effort.

### How It Works

1. **Start recording:** Command Palette → **WebCure: Record Steps (Automatic)**
2. You are prompted for an optional starting URL (defaults to `https://demo.testfire.net`)
3. A browser opens and navigates to the URL
4. **Interact normally** — every click, form input, and Enter key press is captured automatically
5. **Stop recording:** Command Palette → **WebCure: Stop Recording Steps**, or simply close the browser window

When recording stops, the Markdown file opens automatically in the editor preview.

### What Gets Captured

| User Action            | Recorded As                                          | Screenshot                                |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Click a link or button | `Clicked on button 'Login'`                          | Taken after the page reacts to the click  |
| Type into a field      | `Typed 'admin' into 'Username'`                      | Taken immediately (shows the typed value) |
| Type a password        | `Typed '********' into 'Password'`                   | Password value is masked                  |
| Press Enter            | `Pressed 'Enter' on 'Search'`                        | Taken after the page reacts               |
| Navigate to URL        | `Performed 'navigate' on 'Navigated to https://...'` | Taken after page load                     |
| Close the browser      | `Performed 'close' on 'Browser window closed'`       | No screenshot (browser is gone)           |

### Output Structure

Each recording session creates a timestamped folder in the workspace root:

```
WebCure_Steps_2026-03-09_22-13-00/
├── Recording.md      # Markdown log with all steps
├── step_1.png        # Screenshot for step 1
├── step_2.png        # Screenshot for step 2
├── step_3.png        # ...
└── ...
```

The Markdown file contains structured entries like:

```markdown
### Step 3

**Action:** Typed 'admin' into 'Username'

![Screenshot for Step 3](./step_3.png)
```

### Element Identification

The step recorder uses multiple heuristics to produce human-readable element names:

- **`<label for="...">` associations** — preferred for form fields
- **Parent `<label>` wrappers** — for fields wrapped inside labels
- **Adjacent table cell text** — for table-based layouts (e.g., `"Username:"` from a neighboring `<td>`)
- **Previous sibling text** — `<span>`, `<label>`, `<b>` elements before the input
- **Button value/text** — for `<button>` and `<input type="submit">`, the button's own text takes priority
- **ARIA attributes** — `aria-label`, `title`, `placeholder`
- **Element ID or name** — as a fallback

Each step also records CSS selector and XPath in HTML comments for reference.

### Automatic Stop on Browser Close

If you close the browser window while recording is active, the recorder:

1. Logs a final "Browser window closed" step (without a screenshot)
2. Waits for any pending steps to finish writing
3. Automatically stops recording and opens the Markdown preview

---

## Script Recording & Python Playback

WebCure can record your browser actions and generate a Python script that replays them via the API server.

### Step 1: Install the Python Client

The `webcure` Python package lives in the `python/` directory of this repository. Install it once:

```bash
pip install /path/to/webcure/python
```

Or in development/editable mode:

```bash
pip install -e /path/to/webcure/python
```

This provides module-level convenience functions (`navigate`, `click`, `type_text`, etc.) that the generated scripts import.

### Step 2: Record Actions

1. Open the Command Palette (`Cmd+Shift+P`)
2. Run **WebCure: Start Recording**
3. Perform browser actions — navigate, click, type, resize, etc. using any WebCure command (Command Palette or Copilot)
4. Run **WebCure: Stop Recording** (works even if the browser was closed during the session)

All actions are logged in the **WebCure Tools** Output channel. Start and stop recording events are also logged there with timestamps.

A new Python script opens in your editor with the recorded actions.

### Step 3: Run the Generated Script

The script needs the WebCure API server running to execute commands:

1. **Start the API server** — Command Palette → **WebCure: Start API Server** (or it auto-starts when you stop recording)
2. **Run the script:**

```bash
python recording.py
```

### Example Output

```python
#!/usr/bin/env python3
# Auto-generated by WebCure

from webcure import click, close_browser, navigate, resize_browser, type_text

navigate("https://demo.testfire.net")
resize_browser("fullscreen")
click("ONLINE BANKING LOGIN")
type_text("admin", into="#uid")
type_text("admin", into="#passw")
click("#login > table > tbody > tr:nth-child(3) > td:nth-child(2) > input[type=submit]")
click("#btnGetAccount")
close_browser()
```

The Python client automatically detects whether a target is a CSS selector (e.g., `#uid`, `.class`, `div > span`) or visible text (e.g., `"ONLINE BANKING LOGIN"`) and routes it to the correct Playwright locator strategy.

### Python Client API

The `webcure` package also supports class-based usage:

```python
from webcure import WebCure

wc = WebCure(port=5678)
wc.invoke("navigate", {"url": "https://example.com"})
print(wc.health())   # True if API server is running
print(wc.tools())    # List available tool names
```

To change the default port for module-level functions:

```python
import webcure
webcure.set_port(9999)
webcure.navigate("https://example.com")
```

---

## JSON Script Runner

Execute multi-step automation scripts with variables, capture patterns, and retry logic.

### Script Format

```json
{
  "name": "Login and verify dashboard",
  "stopOnError": true,
  "retries": 1,
  "retryDelay": 2000,
  "variables": {
    "baseUrl": "https://example.com",
    "username": "admin"
  },
  "steps": [
    {
      "command": "navigate",
      "args": { "url": "${baseUrl}/login" }
    },
    {
      "command": "typeText",
      "args": { "text": "${username}", "into": "Username" }
    },
    {
      "command": "click",
      "args": { "target": "Sign In" }
    },
    {
      "command": "find",
      "args": { "text": "Dashboard" },
      "captureRef": "dashRef"
    },
    {
      "command": "interact",
      "args": { "action": "click", "ref": "${dashRef}" }
    }
  ]
}
```

### Running Scripts

- **Command Palette:** `Cmd+Shift+P` → **WebCure: Run Script** → select a `.json` file
- **CLI:** `node .webcure/cli.js runScript file=/path/to/script.json`

### Features

| Feature         | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| Variables       | Define at script level, use `${varName}` in any step arg             |
| captureRef      | Auto-extract `[ref=eN]` from step output into a variable             |
| capturePattern  | Regex with capture group to extract values from output text          |
| captureValue    | Map `{ variableName: "property.path" }` to extract structured values |
| Retries         | Script-level `retries` + `retryDelay` with per-step overrides        |
| stopOnError     | Continue or halt on failure (default: true, per-step override)       |
| Command Aliases | Both `camelCase` and `snake_case` accepted                           |

---

## Configuration

Open Settings (`Cmd+,` / `Ctrl+,`) and search for **webcure**:

| Setting                  | Default     | Description                                     |
| ------------------------ | ----------- | ----------------------------------------------- |
| `webcure.api.enabled`    | `false`     | Enable the HTTP API server on activation        |
| `webcure.api.port`       | `5678`      | Port for the HTTP API server                    |
| `webcure.api.host`       | `127.0.0.1` | Host address for the HTTP API server            |
| `webcure.bridge.enabled` | `true`      | Enable the file bridge for AI agent integration |

### Environment Variables

| Variable              | Default  | Description                                             |
| --------------------- | -------- | ------------------------------------------------------- |
| `WEBEXPLORER_BROWSER` | (Chrome) | Set to `msedge` to use Microsoft Edge instead of Chrome |

---

## Development

### Build from Source

```bash
cd ~/Developer/webcure

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (recompile on file changes)
npm run watch

# Package into .vsix
npm run package
```

### Run in Extension Development Host

1. Open the `webcure/` folder in VS Code
2. Press `F5`
3. A new VS Code window opens with the extension loaded
4. Open the Command Palette and type "WebCure" to test commands

### Project Structure

```
webcure/
├── src/
│   ├── extension.ts          # Entry point: registers tools, bridge, API, commands
│   ├── tools.ts              # 28 Language Model Tool classes
│   ├── browserManager.ts     # Playwright-core browser singleton
│   ├── apiServer.ts          # HTTP API server
│   ├── constants.ts          # Bridge directory/file names
│   ├── types.ts              # Shared types
│   ├── bridge/
│   │   ├── file-bridge.ts    # File-based command router
│   │   └── cli-template.js   # CLI helper (copied to .webcure/)
│   └── recorder/
│       ├── action-log.ts       # Start/stop/record actions
│       ├── script-generator.ts # Convert actions to Python
│       └── step-recorder.ts   # Automatic step recorder (Markdown + screenshots)
├── python/
│   ├── pyproject.toml        # Python package metadata
│   ├── setup.py              # Package setup (pip install)
│   └── webcure/
│       ├── __init__.py       # Convenience functions (navigate, click, etc.)
│       └── client.py         # WebCure API client class
├── tests/
│   ├── MANUAL-TEST-RESULTS.md  # Manual test documentation
│   ├── bridge-integration-tests.sh  # Automated bridge integration tests
│   └── unit/
│       └── tools.test.ts     # Unit tests (bridge routing, recording, params)
├── status/
│   ├── project_status_01.md  # Initial release status report
│   ├── project_status_02.md  # Recording fix & Python package
│   ├── project_status_03.md  # Action persistence & interact tool fixes
│   └── project_status_04.md  # Step recorder feature
├── out/                      # Compiled JavaScript (tsc output)
├── dist/                     # Packaged .vsix file
├── package.json              # Extension manifest + tool/command declarations
├── tsconfig.json             # TypeScript configuration
└── README.md
```

### Testing

```bash
# Run unit tests (bridge routing + parameter transformation)
npm run test:unit

# Run automated bridge integration tests (requires VS Code + extension active)
bash tests/bridge-integration-tests.sh
```

---

## Troubleshooting

### Extension doesn't activate

- Make sure VS Code version is 1.95 or later (required for `vscode.lm.registerTool`)
- Check the Output panel → select "WebCure Tools" for error messages

### Browser doesn't launch

- WebCure uses `playwright-core` which connects to your **system Chrome** (not a bundled Chromium)
- Make sure Google Chrome or Microsoft Edge is installed
- To use Edge: set environment variable `WEBEXPLORER_BROWSER=msedge`

### Copilot doesn't use the tools

- Ensure GitHub Copilot is active and you have a Copilot subscription
- The tools should appear when you type `#explorer_` in Copilot chat
- Try asking Copilot explicitly: "Use explorer_navigate to go to https://example.com"

### File bridge doesn't respond

- Check that `webcure.bridge.enabled` is `true` in settings
- Verify `.webcure/` directory exists in your workspace root
- Check that `input.json` is being created (the CLI writes it)
- Look at the Output panel → "WebCure Tools" for errors

### .vsix build fails

- Run `npm install` first to ensure all dependencies are installed
- If `vsce` is not found: `npx @vscode/vsce package -o dist/webcure.vsix`
