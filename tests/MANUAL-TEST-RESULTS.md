# WebCure Manual Test Results

**Date:** 2026-03-07  
**Extension Version:** 1.0.0  
**Playwright:** 1.58.2  
**Browser:** System Chrome  
**Test Site:** https://the-internet.herokuapp.com

---

## Test Summary

| Category                  | Tests  | Passed | Failed |
| ------------------------- | ------ | ------ | ------ |
| Language Model Tools (28) | 40     | 40     | 0      |
| File-Bridge Commands      | 29     | 29     | 0      |
| **Total**                 | **69** | **69** | **0**  |

### Bug Fixed During Testing

- **`explorer_snapshot`** — `page.accessibility.snapshot()` was removed in Playwright 1.58. Rewrote to use `page.locator('body').ariaSnapshot()` with separate interactive element registration.
- **`explorer_click` dialog race condition** — The original click race had an unhandled promise rejection. Fixed by chaining `.then().catch()` and adding `timeout: 6000` to Playwright click.

---

## Language Model Tool Tests

Each row shows: the LM tool invocation, the equivalent File-Bridge command, and the Command Palette command.

### 1. Navigation Tools

| #   | LM Tool Call                                                      | File-Bridge Command                                                          | Command Palette                |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| 1   | `explorer_navigate` `{url: "https://the-internet.herokuapp.com"}` | `{"command":"navigate","args":{"url":"https://the-internet.herokuapp.com"}}` | WebCure: Navigate to URL       |
| 2   | `explorer_navigate_back` `{}`                                     | `{"command":"goBack","args":{}}`                                             | WebCure: Navigate Back         |
| 3   | `explorer_resize` `{width:800, height:600}`                       | `{"command":"resize","args":{"width":800,"height":600}}`                     | WebCure: Resize Browser Window |
| 4   | `explorer_resize` `{width:1280, height:800}` (restore)            | `{"command":"fullscreenBrowser","args":{}}`                                  | WebCure: Resize Browser Window |

**Results:** All PASS

### 2. Element Interaction Tools

| #   | LM Tool Call                                                                     | File-Bridge Command                                                             | Command Palette                |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| 5   | `explorer_click` `{text: "Form Authentication"}`                                 | `{"command":"click","args":{"target":"Form Authentication"}}`                   | WebCure: Click Element         |
| 6   | `explorer_hover` `{text: "Login"}`                                               | `{"command":"hover","args":{"target":"Login"}}`                                 | WebCure: Hover Element         |
| 7   | `explorer_find` `{text: "Login"}`                                                | `{"command":"find","args":{"text":"Login"}}`                                    | WebCure: Find Element          |
| 8   | `explorer_find` `{selector: "#username"}`                                        | `{"command":"find","args":{"selector":"#username"}}`                            | WebCure: Find Element          |
| 9   | `explorer_interact` `{action:"clear", ref:"e7"}`                                 | `{"command":"interact","args":{"action":"clear","ref":"e7"}}`                   | WebCure: Interact with Element |
| 10  | `explorer_interact` `{action:"type", ref:"e7", value:"testuser"}`                | `{"command":"interact","args":{"action":"type","ref":"e7","value":"testuser"}}` | WebCure: Interact with Element |
| 11  | `explorer_interact` `{action:"click", text:"Login"}`                             | `{"command":"interact","args":{"action":"click","text":"Login"}}`               | WebCure: Interact with Element |
| 12  | `explorer_interact` `{action:"focus", ref:"e4"}`                                 | `{"command":"interact","args":{"action":"focus","ref":"e4"}}`                   | WebCure: Interact with Element |
| 13  | `explorer_interact` `{action:"press", ref:"e4", value:"Enter"}`                  | `{"command":"interact","args":{"action":"press","ref":"e4","value":"Enter"}}`   | WebCure: Interact with Element |
| 14  | `explorer_interact` `{action:"check", ref:"e3"}`                                 | `{"command":"interact","args":{"action":"check","ref":"e3"}}`                   | WebCure: Interact with Element |
| 15  | `explorer_interact` `{action:"uncheck", ref:"e3"}`                               | `{"command":"interact","args":{"action":"uncheck","ref":"e3"}}`                 | WebCure: Interact with Element |
| 16  | `explorer_drag` `{startRef:"e1", endRef:"e2", startElement:"A", endElement:"B"}` | `{"command":"drag","args":{"source":"e1","target":"e2"}}`                       | WebCure: Drag Element          |

**Results:** All PASS

### 3. Form & Input Tools

| #   | LM Tool Call                                                                                                                                                        | File-Bridge Command                                                                     | Command Palette              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| 17  | `explorer_type` `{selector:"#username", value:"tomsmith"}`                                                                                                          | `{"command":"typeText","args":{"selector":"#username","text":"tomsmith"}}`              | WebCure: Type Text           |
| 18  | `explorer_type` `{selector:"#password", value:"SuperSecretPassword!"}`                                                                                              | `{"command":"typeText","args":{"selector":"#password","text":"SuperSecretPassword!"}}`  | WebCure: Type Text           |
| 19  | `explorer_type_from_file` `{selector:"#target", filePath:"/tmp/test.txt"}`                                                                                          | `{"command":"typeFromFile","args":{"selector":"#target","filePath":"/tmp/test.txt"}}`   | WebCure: Type Text from File |
| 20  | `explorer_press_key` `{key: "Enter"}`                                                                                                                               | `{"command":"pressKey","args":{"key":"Enter"}}`                                         | WebCure: Press Key           |
| 21  | `explorer_press_key` `{key: "a"}`                                                                                                                                   | `{"command":"pressKey","args":{"key":"a"}}`                                             | WebCure: Press Key           |
| 22  | `explorer_select_option` `{selector:"#dropdown", values:["2"]}`                                                                                                     | `{"command":"selectOption","args":{"selector":"#dropdown","value":"2"}}`                | WebCure: Select Option       |
| 23  | `explorer_fill_form` `{fields:[{name:"username",ref:"e2",type:"textbox",value:"tomsmith"},{name:"password",ref:"e3",type:"textbox",value:"SuperSecretPassword!"}]}` | `{"command":"fillForm","args":{"fields":[...]}}`                                        | WebCure: Fill Form           |
| 24  | `explorer_file_upload` `{selector:"#file-upload", paths:["/tmp/test.txt"]}`                                                                                         | `{"command":"uploadFile","args":{"selector":"#file-upload","paths":["/tmp/test.txt"]}}` | WebCure: Upload File         |

**Results:** All PASS

### 4. Inspection & Extraction Tools

| #   | LM Tool Call                                            | File-Bridge Command                                                   | Command Palette                 |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| 25  | `explorer_extract` `{}` (full page)                     | `{"command":"extract","args":{}}`                                     | WebCure: Extract Text Content   |
| 26  | `explorer_extract` `{selector: "h2"}`                   | `{"command":"extract","args":{"selector":"h2"}}`                      | WebCure: Extract Text Content   |
| 27  | `explorer_snapshot` `{}`                                | `{"command":"snapshot","args":{}}`                                    | WebCure: Take Snapshot          |
| 28  | `explorer_evaluate` `{function:"() => document.title"}` | `{"command":"evaluate","args":{"expression":"() => document.title"}}` | WebCure: Evaluate JavaScript    |
| 29  | `explorer_take_screenshot` `{}` (viewport)              | `{"command":"screenshot","args":{}}`                                  | WebCure: Take Screenshot        |
| 30  | `explorer_take_screenshot` `{fullPage: true}`           | `{"command":"screenshot","args":{"fullPage":true}}`                   | WebCure: Take Screenshot        |
| 31  | `explorer_scrape_page` `{}`                             | `{"command":"scrapePage","args":{}}`                                  | WebCure: Scrape Page Structure  |
| 32  | `explorer_scrape_menu` `{}`                             | `{"command":"scrapeMenu","args":{}}`                                  | WebCure: Scrape Menu/Navigation |

**Results:** All PASS

### 5. Wait Tools

| #   | LM Tool Call                                                         | File-Bridge Command                                                             | Command Palette           |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------- |
| 33  | `explorer_wait_for` `{text:"Hello World!", timeout:15000}`           | `{"command":"waitForText","args":{"text":"Hello World!","timeout":15000}}`      | WebCure: Wait For Text    |
| 34  | `explorer_wait_for` `{time: 1}`                                      | `{"command":"wait","args":{"ms":1000}}`                                         | WebCure: Wait For Text    |
| 35  | `explorer_wait_for_element` `{state:"visible", text:"Hello World!"}` | `{"command":"waitForElement","args":{"text":"Hello World!","state":"visible"}}` | WebCure: Wait For Element |

**Results:** All PASS

### 6. Dialog Tools

| #   | LM Tool Call                                                                          | File-Bridge Command                                                                   | Command Palette        |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- |
| 36  | `explorer_click` `{text:"Click for JS Alert"}` → auto-accepted                        | `{"command":"click","args":{"target":"Click for JS Alert"}}`                          | WebCure: Click Element |
| 37  | `explorer_handle_dialog` `{accept:true}` (read auto-handled)                          | `{"command":"getDialogText","args":{}}`                                               | WebCure: Handle Dialog |
| 38  | `explorer_handle_dialog` `{accept:false}` → click Confirm → dismissed                 | `{"command":"setDialogAction","args":{"accept":false}}` then click                    | WebCure: Handle Dialog |
| 39  | `explorer_handle_dialog` `{accept:true}` → click Confirm → accepted                   | `{"command":"handleDialog","args":{"accept":true}}`                                   | WebCure: Handle Dialog |
| 40  | `explorer_handle_dialog` `{accept:true, promptText:"Hello from webcure"}` → JS Prompt | `{"command":"handleDialog","args":{"accept":true,"promptText":"Hello from webcure"}}` | WebCure: Handle Dialog |

**Results:** All PASS  
**Verified:** Page showed "You clicked: Cancel" after dismiss, "You clicked: Ok" after accept, "You entered: Hello from webcure" after prompt.

### 7. Network & Console Tools

| #   | LM Tool Call                     | File-Bridge Command                       | Command Palette               |
| --- | -------------------------------- | ----------------------------------------- | ----------------------------- |
| 41  | `explorer_console_messages` `{}` | `{"command":"consoleMessages","args":{}}` | WebCure: Get Console Messages |
| 42  | `explorer_network_requests` `{}` | `{"command":"networkRequests","args":{}}` | WebCure: Get Network Requests |

**Results:** All PASS

### 8. Browser Management Tools

| #   | LM Tool Call                                 | File-Bridge Command                          | Command Palette        |
| --- | -------------------------------------------- | -------------------------------------------- | ---------------------- |
| 43  | `explorer_tabs` `{action:"list"}`            | `{"command":"listTabs","args":{}}`           | WebCure: Manage Tabs   |
| 44  | `explorer_tabs` `{action:"new"}`             | `{"command":"newTab","args":{}}`             | WebCure: Manage Tabs   |
| 45  | `explorer_tabs` `{action:"select", index:1}` | `{"command":"selectTab","args":{"index":1}}` | WebCure: Manage Tabs   |
| 46  | `explorer_tabs` `{action:"close", index:2}`  | `{"command":"closeTab","args":{"index":2}}`  | WebCure: Manage Tabs   |
| 47  | `explorer_install` `{}`                      | `{"command":"install","args":{}}`            | —                      |
| 48  | `explorer_close` `{}`                        | `{"command":"closeBrowser","args":{}}`       | WebCure: Close Browser |

**Results:** All PASS

---

## File-Bridge Only Command Tests

These commands have no LM tool equivalent.

| #   | Bridge Command         | Args                                         | Result                                      | Status |
| --- | ---------------------- | -------------------------------------------- | ------------------------------------------- | ------ |
| 49  | `launchBrowser`        | `{url:"https://the-internet.herokuapp.com"}` | URL, title, viewport returned               | PASS   |
| 50  | `scrollDown`           | `{pixels:300}`                               | `{scrolled:"down", pixels:300}`             | PASS   |
| 51  | `scrollUp`             | `{pixels:300}`                               | `{scrolled:"up", pixels:300}`               | PASS   |
| 52  | `scrollRight`          | `{}`                                         | `{scrolled:"right", pixels:300}`            | PASS   |
| 53  | `scrollLeft`           | `{}`                                         | `{scrolled:"left", pixels:300}`             | PASS   |
| 54  | `doubleClick`          | `{target:"Click for JS Alert"}`              | `{doubleClicked:...}`                       | PASS   |
| 55  | `rightClick`           | `{target:"Context Menu"}`                    | `{rightClicked:...}`                        | PASS   |
| 56  | `refresh`              | `{}`                                         | `{refreshed:true}`                          | PASS   |
| 57  | `goForward`            | `{}`                                         | `{wentForward:true}`                        | PASS   |
| 58  | `switchWindow`         | `{title:"Internet"}`                         | `{switchedTo:"Internet"}`                   | PASS   |
| 59  | `getPageInfo`          | `{}`                                         | `{running:true, url:..., title:...}`        | PASS   |
| 60  | `getPageContent`       | `{}`                                         | HTML content returned                       | PASS   |
| 61  | `getPageText`          | `{}`                                         | Body text returned                          | PASS   |
| 62  | `getAccessibilityTree` | `{}`                                         | Accessibility tree YAML                     | PASS   |
| 63  | `highlight`            | `{target:"Form Authentication"}`             | `{highlighted:...}`                         | PASS   |
| 64  | `setDialogAction`      | `{accept:false}`                             | `{configured:true, willAccept:false}`       | PASS   |
| 65  | `getDialogText`        | `{}`                                         | Dialog type, message, response              | PASS   |
| 66  | `startRecording`       | `{}`                                         | `{recording:true}`                          | PASS   |
| 67  | `stopRecording`        | `{}`                                         | `{actionCount:1, script:...}`               | PASS   |
| 68  | `wait`                 | `{ms:1000}`                                  | `Waited 1s`                                 | PASS   |
| 69  | `unknown command`      | `{}`                                         | `{status:"error", error:"Unknown command"}` | PASS   |
