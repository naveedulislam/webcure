import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserManager } from '../browserManager';
import { Page } from 'playwright-core';
import { getEngineScript } from './element-rules-engine';

declare global {
    interface Window {
        recordStep?: (eventData: any) => void;
        __webcureStepRecorderAttached?: boolean;
        __webcure?: any;
    }
}

export type RecordingMode = 'markdown' | 'python' | 'both';

export interface RecordingOptions {
    folderName?: string;        // custom folder name for markdown/both modes
    scriptName?: string;        // custom .py filename for python/both modes
    defaultWaitSeconds?: number; // time.sleep(N) inserted after each action step in the Python script
}

let isRecordingSteps = false;
let currentMarkdownPath: string | undefined = undefined;
let currentLogDir: string | undefined = undefined;   // folder used for the current run
let stepCounter = 0;
let outputChannel: vscode.OutputChannel | undefined;
let stepQueue: Promise<void> = Promise.resolve();
let currentRecordingMode: RecordingMode = 'markdown';
let currentScriptName: string | undefined = undefined;
let currentDefaultWaitSeconds: number = 0;
let recordedStepsData: any[] = [];

export function setStepRecorderOutputChannel(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];
}

/**
 * Initializes the markdown file for logging steps.
 */
function initMarkdownLog(customFolderName?: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error("A workspace must be open to save the step recording log.");
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const timestamp = getTimestamp();
    const folderName = customFolderName || `WebCure_Steps_${timestamp}`;
    const logDir = path.join(workspaceRoot, folderName);

    // Create a dedicated directory for the run to hold the Markdown file and screenshots
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    const mdPath = path.join(logDir, 'Recording.md');

    const header = `# WebCure Step Recording
    
Recorded automatically starting at: ${new Date().toLocaleString()}

`;
    fs.writeFileSync(mdPath, header, 'utf8');
    currentMarkdownPath = mdPath;
    stepCounter = 0;
    return logDir;
}

/**
 * Extracts a concise English action description.
 *
 * If the event comes from the browser-injected rules engine it will already
 * contain a `description` field produced by `window.__webcure.describeAction`.
 * Node-side-only events (navigate, close) are still formatted here.
 */
function formatActionDescription(eventData: any): string {
    // The rules engine already produced a description in the browser
    if (eventData.description) return eventData.description;

    // Fallback for Node-only events (navigate, close, etc.)
    const { type, tagName, text, key } = eventData || {};
    const safeName = String(text || tagName || 'element').replace(/\s+/g, ' ').trim().substring(0, 50);

    if (type === 'navigate') return `Navigated to ${safeName}`;
    if (type === 'close')    return `Browser window closed`;
    if (type === 'keydown' && key) return `Pressed ${key} on '${safeName}'`;
    return `Performed '${type}' on '${safeName}'`;
}

/**
 * Handle events coming from the browser page.
 */
async function handleBrowserStep(eventData: any) {
    if (!isRecordingSteps) return;

    // ── Assertion mode intercept ──────────────────────────────────────────
    // When assertion mode is active, the next click is converted into an
    // assertion step instead of a regular action.
    if (pendingAssertionType && eventData.type === 'click') {
        const assertData = await processAssertionClick(eventData);
        if (!assertData) return; // user cancelled prompt
        eventData = assertData;
    }

    if (currentRecordingMode !== 'python') {
        if (!currentMarkdownPath) return;
    }

    // Store step data for Python generation
    recordedStepsData.push(eventData);

    // Skip markdown writing in python-only mode
    if (currentRecordingMode === 'python') return;

    // Enqueue the step to prevent race conditions on stepCounter and file writes
    stepQueue = stepQueue.then(async () => {
        if (!isRecordingSteps || !currentMarkdownPath) return;

        try {
            // For 'close' events, skip screenshot — the page is already gone.
            // Do NOT call BrowserManager.getPage() here as it would open a new browser.
            const isBrowserClose = eventData.type === 'close' && eventData.tagName === 'Browser';
            const isSleepStep = eventData.type === 'sleep';

            stepCounter++;
            const currentStep = stepCounter; // Capture synchronously within queue

            // 1. Determine action text
            const actionText = formatActionDescription(eventData);
            if (outputChannel) {
                outputChannel.appendLine(`[Step Recorder] ${actionText}`);
            }

            // 2. Take a screenshot (skip for browser close events)
            const screenshotName = `step_${currentStep}.png`;
            const logDir = path.dirname(currentMarkdownPath!);
            const screenshotPath = path.join(logDir, screenshotName);
            let screenshotTaken = false;

            if (!isBrowserClose && !isSleepStep) {
                // Use getExistingPage to avoid opening a blank browser
                const page = BrowserManager.getExistingPage();
                if (page) {
                    // For 'type' events the value is already visible in the field when the
                    // change event fires, so capture immediately. For clicks and other
                    // actions, add a small delay to let the page react.
                    if (eventData.type !== 'type') {
                        await new Promise(r => setTimeout(r, 200));
                    }
                    // Ensure the page hasn't been closed in the delay
                    if (!page.isClosed()) {
                        await page.screenshot({ path: screenshotPath });
                        screenshotTaken = true;
                    }
                }
            }

            // 3. Append to Markdown
            const screenshotMarkdown = screenshotTaken
                ? `![Screenshot for Step ${currentStep}](./${screenshotName})`
                : isBrowserClose ? `*(No screenshot — browser was closed)*`
                : isSleepStep   ? `*(Pause — no screenshot taken)*`
                : `*(No screenshot)*`;

            const isAssertion = String(eventData.type).startsWith('assert_');
            const stepLabel = isAssertion ? '✅ ASSERT' : 'Action';
            const assertionMeta = isAssertion ? `
  assertionType: ${eventData.type}
  assertionValue: ${JSON.stringify(eventData.assertionValue ?? '')}
  assertionMatchType: ${eventData.assertionMatchType || ''}
  assertionAttribute: ${eventData.assertionAttribute || ''}` : '';

            const mdEntry = `
### Step ${currentStep}
**${stepLabel}:** ${actionText}
<!-- Details: 
  tagName: ${eventData.tagName || ''}
  role: ${eventData.role || ''}
  category: ${eventData.category || ''}
  id: ${eventData.id || ''}
  cssSelector: ${eventData.cssSelector || ''}
  xpath: ${eventData.xpath || ''}
  locators: ${JSON.stringify(eventData.locators || [])}
  context: ${JSON.stringify(eventData.context || {})}${assertionMeta}
-->

${screenshotMarkdown}

---
`;
            if (currentMarkdownPath) {
                fs.appendFileSync(currentMarkdownPath, mdEntry, 'utf8');
            }

        } catch (error) {
            if (outputChannel) {
                outputChannel.appendLine(`[Step Recorder Error] Error logging step: ${error}`);
            }
        }
    }).catch(err => {
        if (outputChannel) {
            outputChannel.appendLine(`[Step Recorder Queue Error] ${err}`);
        }
    });

    return stepQueue;
}

/**
 * Starts compiling steps automatically via the Browser page
 */
export async function startStepRecorder(initialUrl?: string, mode: RecordingMode = 'markdown', options: RecordingOptions = {}) {
    if (isRecordingSteps) {
        vscode.window.showInformationMessage("Browser Session recording is already active.");
        return;
    }

    try {
        currentRecordingMode = mode;
        currentScriptName = options.scriptName;
        currentDefaultWaitSeconds = options.defaultWaitSeconds ?? 0;
        recordedStepsData = [];
        currentLogDir = undefined;

        // For markdown / both: create the timestamped folder and init the .md file.
        // For python-only: no folder — the script goes directly to workspace root.
        if (mode !== 'python') {
            currentLogDir = initMarkdownLog(options.folderName);  // also sets currentMarkdownPath
        }

        const page = await BrowserManager.getPage();

        // Check if `recordStep` has already been exposed on this page instance
        const isExposed = await page.evaluate(() => typeof window.recordStep === 'function').catch(() => false);

        if (!isExposed) {
            // Expose the Node.js handler to the browser window context
            await page.exposeFunction('recordStep', handleBrowserStep);

            // Build the injectable scripts as strings so we can use them
            // both for addInitScript (future navigations) AND page.evaluate
            // (the currently loaded page).
            const engineScript = getEngineScript();
            const eventWiringScript = `
                (() => {
                    if (window.__webcureStepRecorderAttached) return;
                    window.__webcureStepRecorderAttached = true;

                    const engine = window.__webcure;
                    if (!engine) {
                        console.warn('[WebCure] Rules engine not available — event wiring skipped');
                        return;
                    }

                    // Event buffer for ordering 'type' before 'keydown(Enter)'
                    let eventBuffer = [];
                    let flushTimeout = null;

                    // --- Deferred Pointerdown State ---
                    let pendingPointerdown = null;      // { el, data, timerId }

                    // Track Enter keypress to suppress synthetic form-submission clicks
                    let lastEnterKeydownTime = 0;

                    function flushEvents() {
                        eventBuffer.sort((a, b) => {
                            if (a.type === 'type' && b.type === 'keydown') return -1;
                            if (a.type === 'keydown' && b.type === 'type') return 1;
                            return 0;
                        });

                        // Deduplicate: when Enter is pressed in a form field, the
                        // browser fires a synthetic click on the form's submit button.
                        // Suppress any click flagged as a form-submission duplicate.
                        const hasEnterKeydown = eventBuffer.some(ev => ev.type === 'keydown' && ev.key === 'Enter');
                        if (hasEnterKeydown) {
                            eventBuffer = eventBuffer.filter(ev => !ev._isFormSubmitClick);
                        }

                        eventBuffer.forEach(ev => {
                            try { window.recordStep(ev); } catch (err) {
                                console.warn('[WebCure] recordStep failed:', err);
                            }
                        });
                        eventBuffer = [];
                        flushTimeout = null;
                    }

                    function queueEvent(eventPayload) {
                        eventBuffer.push(eventPayload);
                        if (!flushTimeout) {
                            flushTimeout = setTimeout(flushEvents, 50);
                        }
                    }

                    /**
                     * Use the rules engine to inspect an element and build a full
                     * event payload including description, locators, and context.
                     *
                     * IMPORTANT: We snapshot all data eagerly because the element
                     * may be removed from the DOM before the deferred timer fires
                     * (e.g. Radix Select options vanish on pointerdown).
                     */
                    function buildEventData(el, eventType, extras) {
                        try {
                            const info = engine.inspectElement(el, eventType, extras);
                            if (!info) return null;
                            return { type: eventType, ...info, ...(extras || {}) };
                        } catch (err) {
                            console.warn('[WebCure] buildEventData error:', err);
                            return null;
                        }
                    }

                    // POINTERDOWN — deferred recording approach
                    //
                    // Captures ALL pointerdowns on meaningful targets, then waits
                    // a short window:
                    //   • If a matching click fires → cancel timer, record from click
                    //   • If NO click fires (element removed from DOM, e.g. Radix
                    //     Select option) → timer fires and records the pointerdown
                    document.addEventListener('pointerdown', (e) => {
                        const target = e.target;
                        if (!target || target === document.body || target === document.documentElement) return;
                        // File inputs are handled by the Node.js filechooser interceptor
                        if (target.tagName === 'INPUT' && (target.type || '').toLowerCase() === 'file') return;

                        // Flush any previously pending pointerdown
                        if (pendingPointerdown) {
                            clearTimeout(pendingPointerdown.timerId);
                            queueEvent(pendingPointerdown.data);
                            pendingPointerdown = null;
                        }

                        const el = engine.resolveInteractiveElement(target);
                        if (!el) return;

                        // Snapshot data NOW while the element is still in the DOM
                        const data = buildEventData(el, 'click');
                        if (!data) return;

                        const timerId = setTimeout(() => {
                            if (pendingPointerdown) {
                                queueEvent(pendingPointerdown.data);
                                pendingPointerdown = null;
                            }
                        }, 400);

                        pendingPointerdown = { el, data, timerId };
                    }, true);

                    // CLICK
                    document.addEventListener('click', (e) => {
                        const target = e.target;

                        // If click lands on body/documentElement, it likely means the
                        // real target was removed (portal closed). Let the deferred
                        // pointerdown timer handle it — do NOT flush here.
                        if (target === document.body || target === document.documentElement) return;
                        // File inputs are handled by the Node.js filechooser interceptor
                        if (target && target.tagName === 'INPUT' && (target.type || '').toLowerCase() === 'file') return;

                        // ── Assertion mode ────────────────────────────────────
                        // In assertion mode, use the *actual clicked element*
                        // instead of walking up to find an interactive ancestor.
                        // This lets users assert on text spans, divs, headings, etc.
                        if (window.__webcureAssertMode) {
                            const data = buildEventData(target, 'click');
                            if (data) queueEvent(data);
                            return;
                        }

                        if (pendingPointerdown) {
                            const pd = pendingPointerdown;
                            if (target === pd.el || (pd.el.contains && pd.el.contains(target)) || (target.contains && target.contains(pd.el))) {
                                clearTimeout(pd.timerId);
                                pendingPointerdown = null;
                                queueEvent(pd.data);
                                return;
                            }
                            clearTimeout(pd.timerId);
                            queueEvent(pd.data);
                            pendingPointerdown = null;
                        }

                        const el = engine.resolveInteractiveElement(target);
                        if (!el) return;

                        // Skip clicks that resolved to non-interactive elements.
                        // If resolveInteractiveElement fell back to the raw target and
                        // it's a generic container/text element, it's just a background
                        // click — not a meaningful user action worth recording.
                        const elTag = (el.tagName || '').toLowerCase();
                        const elRole = el.getAttribute && el.getAttribute('role') || '';
                        const isReallyInteractive = ['a', 'button', 'input', 'select', 'textarea', 'summary', 'details'].includes(elTag)
                            || ['button', 'link', 'menuitem', 'option', 'tab', 'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox', 'slider'].includes(elRole)
                            || el.getAttribute('tabindex') === '0'
                            || el.hasAttribute('data-slot')
                            || el.hasAttribute('data-radix-collection-item');
                        if (!isReallyInteractive) return;

                        const data = buildEventData(el, 'click');
                        if (data) {
                            // Flag clicks on submit buttons that occur shortly after
                            // an Enter keydown — these are synthetic form-submission
                            // clicks fired by the browser, not real user clicks.
                            const now = Date.now();
                            if (now - lastEnterKeydownTime < 200) {
                                const tag = (el.tagName || '').toLowerCase();
                                const elType = (el.type || '').toLowerCase();
                                const role = (el.getAttribute && el.getAttribute('role')) || '';
                                const isSubmitish = (tag === 'input' && (elType === 'submit' || elType === 'image'))
                                    || tag === 'button'
                                    || role === 'button';
                                if (isSubmitish) {
                                    data._isFormSubmitClick = true;
                                }
                            }
                            queueEvent(data);
                        }
                    }, true);

                    // CHANGE (typing / input / select)
                    document.addEventListener('change', (e) => {
                        const target = e.target;
                        // File inputs are handled by the Node.js filechooser interceptor
                        if (target && target.tagName === 'INPUT' && (target.type || '').toLowerCase() === 'file') return;
                        const el = engine.resolveInteractiveElement(target) || target;
                        const tag = (el.tagName || '').toLowerCase();
                        if (tag === 'select') {
                            // Record the visible option label, not the raw value attribute,
                            // so the generated script uses human-readable text.
                            const selectedOpt = el.options && el.options[el.selectedIndex];
                            const label = selectedOpt ? selectedOpt.text.trim() : target.value;
                            const data = buildEventData(el, 'select', { value: target.value, label });
                            if (data) queueEvent(data);
                        } else {
                            const data = buildEventData(el, 'type', { value: target.value });
                            if (data) queueEvent(data);
                        }
                    }, true);

                    // KEYDOWN (Enter)
                    document.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            lastEnterKeydownTime = Date.now();
                            const target = e.target;
                            const el = engine.resolveInteractiveElement(target) || target;
                            const data = buildEventData(el, 'keydown', { key: 'Enter' });
                            if (data) queueEvent(data);
                        }
                    }, true);
                })();
            `;

            // Register for future navigations (new page loads / SPA route changes)
            await page.addInitScript(engineScript);
            await page.addInitScript(eventWiringScript);

            // CRITICAL: Also inject into the CURRENT page immediately.
            // addInitScript only runs on future navigations — if the page is
            // already loaded (typical workflow: user opens app, then starts
            // recording), the scripts would never run without this.
            await page.evaluate(engineScript);
            await page.evaluate(eventWiringScript);

            // FILE CHOOSER — intercept native OS file dialogs to capture real paths
            page.on('filechooser', async (chooser: any) => {
                if (!isRecordingSteps) return;

                // Build locators by reading element attributes directly (more reliable
                // than calling __webcure.generateLocators through evaluate)
                let locators: any[] = [];
                try {
                    const attrs = await chooser.element().evaluate((node: any) => {
                        const result: Record<string, string> = {
                            id: node.id || '',
                            name: node.name || '',
                        };
                        for (const attr of ['data-testid', 'data-cy', 'data-test', 'data-qa']) {
                            const val = node.getAttribute(attr);
                            if (val) { result.testIdAttr = attr; result.testIdVal = val; break; }
                        }
                        return result;
                    });
                    if (attrs.testIdVal) locators.push({ strategy: 'testId', value: `[${attrs.testIdAttr}="${attrs.testIdVal}"]`, confidence: 1.0 });
                    if (attrs.id) locators.push({ strategy: 'id', value: attrs.id, confidence: 0.95 });
                    if (attrs.name) locators.push({ strategy: 'name', value: attrs.name, confidence: 0.75 });
                    locators.push({ strategy: 'css', value: attrs.id ? `#${attrs.id}` : 'input[type="file"]', confidence: 0.6 });
                } catch {
                    locators = [{ strategy: 'css', value: 'input[type="file"]', confidence: 0.5 }];
                }

                const filePath = await vscode.window.showInputBox({
                    prompt: 'File path to upload — leave blank to insert a TODO placeholder in the script',
                    placeHolder: '/absolute/path/to/file.pdf',
                    ignoreFocusOut: true,
                });

                // undefined = Escape pressed, '' = blank submitted — both become placeholder
                const resolvedPath = filePath?.trim() ?? '';

                if (resolvedPath) {
                    await chooser.setFiles(resolvedPath);
                } else {
                    try { await chooser.setFiles([]); } catch { /* ignore — dialog dismissed */ }
                }

                const fileName = resolvedPath
                    ? (resolvedPath.split('/').pop() || resolvedPath.split('\\').pop() || resolvedPath)
                    : null;
                handleBrowserStep({
                    type: 'fileupload',
                    tagName: 'INPUT',
                    filePath: resolvedPath,   // empty string → placeholder in generated script
                    locators,
                    description: fileName ? `Uploaded file "${fileName}"` : 'File upload (path not specified)',
                });
            });
        }

        isRecordingSteps = true;
        const startMsg = currentLogDir
            ? `Recording started! Log directory: ${currentLogDir}`
            : `Recording started! Python script will be saved to workspace root.`;
        vscode.window.showInformationMessage(startMsg);

        if (outputChannel) {
            outputChannel.show(true);
            outputChannel.appendLine(`\n${'='.repeat(60)}`);
            outputChannel.appendLine(`[WebCure Step Recorder] ACTIVE`);
            outputChannel.appendLine(`Interact with the browser normally. Steps are being recorded to: ${currentMarkdownPath}`);
            outputChannel.appendLine(`${'='.repeat(60)}\n`);
        }

        if (initialUrl) {
            await page.goto(initialUrl, { waitUntil: 'load' });
            // Log the initial navigation manually as it occurs before our script handles DOM clicks
            handleBrowserStep({
                type: 'navigate',
                tagName: 'Browser',
                text: `Navigated to ${initialUrl}`,
                url: initialUrl
            });
        }

        // Listen for the page closing to stop recording automatically
        page.on('close', () => {
            if (isRecordingSteps) {
                // Capture the markdown path before it could be cleared
                const mdPath = currentMarkdownPath;
                if (mdPath) {
                    handleBrowserStep({
                        type: 'close',
                        tagName: 'Browser',
                        text: 'Browser window closed'
                    });
                }

                // Wait for the queue to drain, then stop
                stepQueue.finally(() => {
                    stopStepRecorder();
                });
            }
        });

    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to start Browser Session: ${error.message}`);
        isRecordingSteps = false;
    }
}

/**
 * Stops the step recorder and opens the generated output file(s).
 */
export async function stopStepRecorder() {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage('Browser Session is not currently active.');
        return;
    }

    isRecordingSteps = false;
    const stoppedMode = currentRecordingMode;
    const stepsSnapshot = [...recordedStepsData];
    const savedLogDir = currentLogDir;
    const savedMarkdownPath = currentMarkdownPath;
    const savedScriptName = currentScriptName;

    if (outputChannel) {
        outputChannel.appendLine(`\n${'='.repeat(60)}`);
        outputChannel.appendLine(`[WebCure Step Recorder] STOPPED`);
        outputChannel.appendLine(`Total steps recorded: ${stepsSnapshot.length}`);
        outputChannel.appendLine(`${'='.repeat(60)}\n`);
    }

    // ── Markdown output ──────────────────────────────────────────────────
    if (stoppedMode !== 'python' && savedMarkdownPath && fs.existsSync(savedMarkdownPath)) {
        vscode.window.showInformationMessage(`Recording stopped. Opening log file: ${savedMarkdownPath}`);
        try {
            const uri = vscode.Uri.file(savedMarkdownPath);
            await vscode.workspace.openTextDocument(uri);
            await vscode.commands.executeCommand('markdown.showPreview', uri);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to open markdown log: ${error.message}`);
        }
    }

    // ── Python script output ─────────────────────────────────────────────
    if (stoppedMode === 'python' || stoppedMode === 'both') {
        try {
            const pyScript = generateStepsPythonScript(stepsSnapshot, currentDefaultWaitSeconds);

            // 'both': place script alongside markdown inside the session folder.
            // 'python'-only: no session folder — place directly in workspace root
            //                with a timestamped name to avoid overwriting previous runs.
            let pyPath: string;
            const scriptFilename = (() => {
                const base = savedScriptName || (stoppedMode === 'both' ? 'test_recording.py' : `test_recording_${getTimestamp()}.py`);
                return base.endsWith('.py') ? base : base + '.py';
            })();
            if (stoppedMode === 'both' && savedLogDir) {
                pyPath = path.join(savedLogDir, scriptFilename);
            } else {
                const wf = vscode.workspace.workspaceFolders;
                const root = wf ? wf[0].uri.fsPath : '.';
                pyPath = path.join(root, scriptFilename);
            }

            fs.writeFileSync(pyPath, pyScript, 'utf8');

            const pyUri = vscode.Uri.file(pyPath);
            const pyDoc = await vscode.workspace.openTextDocument(pyUri);
            await vscode.window.showTextDocument(pyDoc);
            vscode.window.showInformationMessage(`Python test script saved: ${pyPath}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to generate Python script: ${error.message}`);
        }
    }

    currentMarkdownPath = undefined;
    currentLogDir = undefined;
    currentScriptName = undefined;
    currentDefaultWaitSeconds = 0;
    stepCounter = 0;
    recordedStepsData = [];
}

// ─── Python Test Script Generation ────────────────────────────────────────────

function pyStr(val: any): string {
    const s = String(val ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    return `"${s}"`;
}

/** Serialise a locators array as a Python list literal (multi-line, indented). */
function locatorsToRepr(locators: any[], step: any, indent: string): string {
    const locs: any[] = Array.isArray(locators) && locators.length > 0
        ? locators
        : buildFallbackLocators(step);

    if (locs.length === 0) return '[]';

    const inner = locs.map(l =>
        `${indent}    {"strategy": ${pyStr(l.strategy || 'css')}, "value": ${pyStr(l.value || '')}, "confidence": ${l.confidence ?? 0}}`,
    ).join(',\n');
    return `[\n${inner},\n${indent}]`;
}

function buildFallbackLocators(step: any): any[] {
    const locs: any[] = [];
    if (step.cssSelector) locs.push({ strategy: 'css', value: step.cssSelector, confidence: 0.4 });
    if (step.xpath)       locs.push({ strategy: 'xpath', value: step.xpath, confidence: 0.3 });
    return locs;
}

function stepToPythonLines(step: any, stepNum: number, indent: string): string[] {
    const { type, locators, value, key, url, text, tagName } = step;
    const lines: string[] = [];

    const comment = (step.description
        || (type === 'navigate' ? `Navigate to ${url || text || ''}` : `Step ${stepNum}`))
        .replace(/\n/g, ' ').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
    lines.push(`${indent}# Step ${stepNum}: ${comment}`);

    if (type === 'navigate') {
        const navUrl = url || (typeof text === 'string' ? text.replace(/^Navigated to /, '').trim() : '');
        if (navUrl) {
            lines.push(`${indent}page.goto(${pyStr(navUrl)})`);
            lines.push(`${indent}page.wait_for_load_state("networkidle")`);
        } else {
            lines.push(`${indent}# (navigate — URL not captured)`);
        }
        lines.push('');
        return lines;
    }

    if (type === 'close') {
        lines.push('');
        return lines;
    }

    // Optional sleep / pause step
    if (type === 'sleep') {
        const secs = step.seconds ?? 1;
        lines.push(`${indent}time.sleep(${secs})  # Wait ${secs}s`);
        lines.push('');
        return lines;
    }

    // File-upload steps recorded via the Node.js filechooser interceptor
    if (type === 'fileupload') {
        const locRepr = locatorsToRepr(locators || [], step, indent);
        if (!step.filePath) {
            lines.push(`${indent}# TODO: Replace the placeholder below with the actual file path`);
            lines.push(`${indent}upload_file(page, ${locRepr}, "/path/to/your/file")`);
        } else {
            lines.push(`${indent}upload_file(page, ${locRepr}, ${pyStr(step.filePath)})`);
        }
        lines.push('');
        return lines;
    }

    // ── Assertion steps ───────────────────────────────────────────────────
    if (type === 'assert_title') {
        lines.push(`${indent}assert_page_title(page, ${pyStr(step.assertionValue || '')})`);
        lines.push('');
        return lines;
    }
    if (type === 'assert_url') {
        const matchType = step.assertionMatchType || 'exact';
        lines.push(`${indent}assert_page_url(page, ${pyStr(step.assertionValue || '')}, ${pyStr(matchType)})`);
        lines.push('');
        return lines;
    }
    if (type === 'assert_snapshot') {
        lines.push(`${indent}assert_page_contains_text(page, ${pyStr(step.assertionValue || '')})`);
        lines.push('');
        return lines;
    }

    // Element-targeted assertions (need locators)
    if (type.startsWith('assert_')) {
        const allLocs = (Array.isArray(locators) && locators.length > 0)
            ? locators : buildFallbackLocators(step);
        if (allLocs.length === 0) {
            lines.push(`${indent}# Could not generate locator for assertion on <${tagName || 'element'}>`);
            lines.push('');
            return lines;
        }
        const locRepr = locatorsToRepr(locators || [], step, indent);

        if (type === 'assert_visible') {
            lines.push(`${indent}assert_element_visible(page, ${locRepr})`);
        } else if (type === 'assert_not_visible') {
            lines.push(`${indent}assert_element_not_visible(page, ${locRepr})`);
        } else if (type === 'assert_text') {
            lines.push(`${indent}assert_element_text(page, ${locRepr}, ${pyStr(step.assertionValue || '')})`);
        } else if (type === 'assert_value') {
            lines.push(`${indent}assert_element_value(page, ${locRepr}, ${pyStr(step.assertionValue || '')})`);
        } else if (type === 'assert_checked') {
            lines.push(`${indent}assert_element_checked(page, ${locRepr}, True)`);
        } else if (type === 'assert_not_checked') {
            lines.push(`${indent}assert_element_checked(page, ${locRepr}, False)`);
        } else if (type === 'assert_enabled') {
            lines.push(`${indent}assert_element_enabled(page, ${locRepr}, True)`);
        } else if (type === 'assert_disabled') {
            lines.push(`${indent}assert_element_enabled(page, ${locRepr}, False)`);
        } else if (type === 'assert_count') {
            lines.push(`${indent}assert_element_count(page, ${locRepr}, ${step.assertionValue ?? 0})`);
        } else if (type === 'assert_attribute') {
            lines.push(`${indent}assert_element_attribute(page, ${locRepr}, ${pyStr(step.assertionAttribute || '')}, ${pyStr(step.assertionValue || '')})`);
        }
        lines.push('');
        return lines;
    }

    // Suppress leftover click/change events on file inputs (filechooser step already covers them)
    const isFileInput = tagName?.toLowerCase() === 'input' &&
        (step.inputType === 'file' || (step.cssSelector || '').includes('type="file"') ||
         (step.xpath || '').includes('@type="file"'));
    if (isFileInput) {
        lines.push(`${indent}# (file-input click/change skipped — captured by upload_file step above)`);
        lines.push('');
        return lines;
    }

    const allLocs = (Array.isArray(locators) && locators.length > 0)
        ? locators : buildFallbackLocators(step);

    if (allLocs.length === 0) {
        lines.push(`${indent}# Could not generate locator for ${type} on <${tagName || 'element'}>`);
        lines.push('');
        return lines;
    }

    const locRepr = locatorsToRepr(locators || [], step, indent);

    if (type === 'click') {
        lines.push(`${indent}self_healing_click(page, ${locRepr})`);
    } else if (type === 'select') {
        const selectVal = step.label || value || '';
        lines.push(`${indent}self_healing_select(page, ${locRepr}, ${pyStr(selectVal)})`);
    } else if (type === 'type') {
        lines.push(`${indent}self_healing_fill(page, ${locRepr}, ${pyStr(value ?? '')})`);
    } else if (type === 'keydown' && key) {
        lines.push(`${indent}self_healing_press(page, ${locRepr}, ${pyStr(key)})`);
    } else {
        lines.push(`${indent}# ${type} on <${tagName || 'element'}> — no automation generated`);
    }

    lines.push('');
    return lines;
}

const PYTHON_HELPERS = `
import re
import sys
import time
import logging
from datetime import datetime
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeoutError

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
_log_filename = f"test_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(_log_filename, mode='w'),
    ],
)
_logger = logging.getLogger("WebCure")
_step_results: list = []  # [(step_num, description, "PASS"|"FAIL", error_msg)]


def _record_step(step_num: int, description: str, passed: bool, error: str = ""):
    status = "PASS" if passed else "FAIL"
    _step_results.append((step_num, description, status, error))
    icon = "\\u2705" if passed else "\\u274C"
    msg = f"{icon}  Step {step_num}: {description} — {status}"
    if error:
        msg += f"  [{error}]"
    _logger.info(msg)


def _print_summary():
    total = len(_step_results)
    passed = sum(1 for r in _step_results if r[2] == "PASS")
    failed = total - passed
    _logger.info("")
    _logger.info("=" * 60)
    _logger.info(f"TEST SUMMARY: {passed}/{total} steps passed, {failed} failed")
    _logger.info("=" * 60)
    if failed:
        _logger.info("Failed steps:")
        for num, desc, status, err in _step_results:
            if status == "FAIL":
                _logger.info(f"  Step {num}: {desc}")
                _logger.info(f"    Error: {err}")
    _logger.info(f"Full log saved to: {_log_filename}")
    _logger.info("=" * 60)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
WAIT_TIMEOUT = 5000  # ms — max time to wait for any locator to become visible


# ---------------------------------------------------------------------------
# Self-healing locator resolution
# ---------------------------------------------------------------------------
def _resolve_locator(page, strategy: str, value: str):
    """Convert a (strategy, value) pair to a Playwright Locator object."""
    if strategy == "testId":
        # value is like '[data-testid="foo"]' — extract just the id
        m = re.search(r'"([^"]+)"', value)
        return page.get_by_test_id(m.group(1) if m else value)
    elif strategy == "id":
        return page.locator(f"#{value}")
    elif strategy == "aria":
        m = re.match(r'^([\\w][\\w-]*)\\[name="([^"]+)"\\]$', value)
        if m:
            return page.get_by_role(m.group(1), name=m.group(2))
        return page.locator(f'[aria-label="{value}"]')
    elif strategy == "ariaLabel":
        return page.get_by_label(value)
    elif strategy == "linkText":
        return page.get_by_role("link", name=value)
    elif strategy == "text":
        return page.get_by_text(value, exact=True)
    elif strategy == "name":
        return page.locator(f'[name="{value}"]')
    elif strategy == "css":
        return page.locator(value)
    elif strategy == "xpath":
        return page.locator(f"xpath={value}")
    else:
        return page.locator(value)


def find_element(page, locators: list, timeout: int = WAIT_TIMEOUT, state: str = "visible"):
    """
    Try each locator strategy in confidence order.
    Returns the first locator whose element is in *state* within *timeout* ms.
    Raises an Exception if none succeed.
    Use state="attached" for hidden elements (e.g. <input type="file">).
    """
    last_err = None
    # Sort descending by confidence so highest-quality locators are tried first
    ordered = sorted(locators, key=lambda l: l.get("confidence", 0), reverse=True)
    for loc in ordered:
        strategy = loc.get("strategy", "css")
        value = loc.get("value", "")
        if not value:
            continue
        try:
            el = _resolve_locator(page, strategy, value)
            el.wait_for(state=state, timeout=timeout)
            return el
        except PWTimeoutError as e:
            last_err = e
        except Exception as e:
            last_err = e
    strategies = [f"{l.get('strategy')}={l.get('value')}" for l in ordered]
    raise Exception(f"Element not found with any of: {strategies}\\nLast error: {last_err}")


def self_healing_click(page, locators: list, timeout: int = WAIT_TIMEOUT):
    """Find the element via self-healing locators then click it."""
    el = find_element(page, locators, timeout)
    el.click()


def self_healing_fill(page, locators: list, value: str, timeout: int = WAIT_TIMEOUT):
    """Find the element via self-healing locators then fill it with *value*."""
    el = find_element(page, locators, timeout)
    el.fill(value)


def self_healing_select(page, locators: list, value: str, timeout: int = WAIT_TIMEOUT):
    """Find the <select> element and choose the matching option.

    Tries by visible label first (more stable), falls back to value attribute.
    """
    el = find_element(page, locators, timeout)
    try:
        el.select_option(label=value)
    except Exception:
        el.select_option(value=value)


def self_healing_press(page, locators: list, key: str, timeout: int = WAIT_TIMEOUT):
    """Find the element via self-healing locators then press *key*."""
    el = find_element(page, locators, timeout)
    el.press(key)


# ---------------------------------------------------------------------------
# File upload helper
# ---------------------------------------------------------------------------
def upload_file(page, locators: list, file_path: str, timeout: int = WAIT_TIMEOUT):
    """
    Upload a file to an <input type="file"> element using self-healing locators.

    Usage (standard file input):
        upload_file(page, locators, "/absolute/path/to/file.pdf")

    Usage (hidden file input — common in modern UIs like Dropzone, React Dropzone):
        # Intercept the file chooser before triggering the upload dialog
        with page.expect_file_chooser() as fc_info:
            page.click(".upload-button")   # the visible trigger element
        file_chooser = fc_info.value
        file_chooser.set_files("/absolute/path/to/file.pdf")

    Usage (drag-and-drop upload zone):
        page.set_input_files('input[type="file"]', "/absolute/path/to/file.pdf")
    """
    # Fall back to generic file-input selector when no locators were captured
    if not locators:
        locators = [{"strategy": "css", "value": 'input[type="file"]', "confidence": 0.5}]
    el = find_element(page, locators, timeout, state="attached")  # file inputs are often hidden
    el.set_input_files(file_path)


# ---------------------------------------------------------------------------
# Self-healing assertion helpers
# ---------------------------------------------------------------------------
def assert_element_visible(page, locators: list, timeout: int = WAIT_TIMEOUT):
    """Assert that the element resolved by self-healing locators is visible."""
    el = find_element(page, locators, timeout)
    assert el.is_visible(), f"Expected element to be visible"


def assert_element_not_visible(page, locators: list, timeout: int = 2000):
    """Assert that no element matching the locators is visible."""
    last_err = None
    ordered = sorted(locators, key=lambda l: l.get("confidence", 0), reverse=True)
    for loc in ordered:
        strategy = loc.get("strategy", "css")
        value = loc.get("value", "")
        if not value:
            continue
        try:
            el = _resolve_locator(page, strategy, value)
            el.wait_for(state="hidden", timeout=timeout)
            return  # success — element is hidden or detached
        except Exception as e:
            last_err = e
    # If none of the locators found ANY element, that also counts as not visible
    if last_err:
        return  # element truly not found → assertion passes


def assert_element_text(page, locators: list, expected_text: str, timeout: int = WAIT_TIMEOUT):
    """Assert that the element's text content contains the expected text (whitespace-normalized)."""
    el = find_element(page, locators, timeout)
    actual = re.sub(r'\\s+', ' ', el.inner_text()).strip()
    expected = re.sub(r'\\s+', ' ', expected_text).strip()
    assert expected in actual, f"Expected text '{expected}' in '{actual[:200]}'"


def assert_element_value(page, locators: list, expected_value: str, timeout: int = WAIT_TIMEOUT):
    """Assert that the input element's value matches."""
    el = find_element(page, locators, timeout)
    actual = el.input_value()
    assert actual == expected_value, f"Expected value '{expected_value}' but got '{actual}'"


def assert_element_checked(page, locators: list, expected: bool = True, timeout: int = WAIT_TIMEOUT):
    """Assert that a checkbox/radio is checked (or unchecked if expected=False)."""
    el = find_element(page, locators, timeout)
    actual = el.is_checked()
    state = "checked" if expected else "unchecked"
    assert actual == expected, f"Expected element to be {state} but it was {'checked' if actual else 'unchecked'}"


def assert_element_enabled(page, locators: list, expected: bool = True, timeout: int = WAIT_TIMEOUT):
    """Assert that the element is enabled (or disabled if expected=False)."""
    el = find_element(page, locators, timeout)
    actual = el.is_enabled()
    state = "enabled" if expected else "disabled"
    assert actual == expected, f"Expected element to be {state} but it was {'enabled' if actual else 'disabled'}"


def assert_page_title(page, expected_title: str):
    """Assert that the page title matches."""
    actual = page.title()
    assert actual == expected_title, f"Expected title '{expected_title}' but got '{actual}'"


def assert_page_url(page, expected_url: str, match_type: str = "exact"):
    """Assert that the page URL matches (exact or contains)."""
    actual = page.url
    if match_type == "contains":
        assert expected_url in actual, f"Expected URL to contain '{expected_url}' but got '{actual}'"
    else:
        assert actual == expected_url, f"Expected URL '{expected_url}' but got '{actual}'"


def assert_element_count(page, locators: list, expected_count: int, timeout: int = WAIT_TIMEOUT):
    """Assert that the number of elements matching the best locator equals expected_count."""
    ordered = sorted(locators, key=lambda l: l.get("confidence", 0), reverse=True)
    for loc in ordered:
        strategy = loc.get("strategy", "css")
        value = loc.get("value", "")
        if not value:
            continue
        try:
            el = _resolve_locator(page, strategy, value)
            el.first.wait_for(state="visible", timeout=timeout)
            actual = el.count()
            assert actual == expected_count, f"Expected {expected_count} elements but found {actual}"
            return
        except AssertionError:
            raise
        except Exception:
            continue
    raise Exception(f"Could not count elements — none of the locators matched")


def assert_element_attribute(page, locators: list, attr_name: str, expected_value: str, timeout: int = WAIT_TIMEOUT):
    """Assert that the element's attribute has the expected value."""
    el = find_element(page, locators, timeout)
    actual = el.get_attribute(attr_name)
    assert actual == expected_value, f"Expected {attr_name}='{expected_value}' but got '{actual}'"


def assert_page_contains_text(page, expected_text: str, timeout: int = WAIT_TIMEOUT):
    """Assert that the page body contains the expected text."""
    page.get_by_text(expected_text, exact=False).first.wait_for(state="visible", timeout=timeout)
`;

export function isStepRecording(): boolean {
    return isRecordingSteps;
}

/**
 * Records an optional sleep/pause step during an active recording.
 */
export async function insertSleepStep() {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage('Browser Session is not active — start recording first.');
        return;
    }
    const input = await vscode.window.showInputBox({
        prompt: 'Sleep duration in seconds',
        value: '1',
        validateInput: v => (!v || isNaN(parseFloat(v)) || parseFloat(v) <= 0) ? 'Enter a positive number' : undefined,
        ignoreFocusOut: true,
    });
    if (!input) return;
    const secs = parseFloat(input);
    handleBrowserStep({
        type: 'sleep',
        seconds: secs,
        description: `Wait ${secs} second${secs !== 1 ? 's' : ''}`,
    });
    if (outputChannel) outputChannel.appendLine(`[Step Recorder] Inserted sleep: ${secs}s`);
}

// ─── Assertion Mode ───────────────────────────────────────────────────────────

export type AssertionType =
    | 'assert_visible'
    | 'assert_not_visible'
    | 'assert_text'
    | 'assert_value'
    | 'assert_checked'
    | 'assert_not_checked'
    | 'assert_enabled'
    | 'assert_disabled'
    | 'assert_title'
    | 'assert_url'
    | 'assert_count'
    | 'assert_attribute'
    | 'assert_snapshot';

let pendingAssertionType: AssertionType | null = null;

/**
 * Activate assertion mode.  The NEXT browser click will be captured as an
 * assertion step instead of a regular action.  Pass `'assert_count'` to
 * additionally prompt the user for the expected count.
 */
export function activateAssertionMode(type: AssertionType) {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage('Browser Session is not active — start recording first.');
        return;
    }
    pendingAssertionType = type;

    // Inject an assertion-mode indicator into the browser page so the
    // event-wiring script knows to treat the next click differently.
    const page = BrowserManager.getExistingPage();
    if (page && !page.isClosed()) {
        page.evaluate(`(() => { window.__webcureAssertMode = "${type}"; })();`).catch(() => {});
    }

    vscode.window.showInformationMessage(`🟢 Assertion mode ON (${type.replace('assert_', '')}): click any element on the page.`);
    if (outputChannel) outputChannel.appendLine(`[Step Recorder] Assertion mode activated: ${type}`);
}

/**
 * Assert: Page Title — captures current title without element interaction.
 */
export async function assertPageTitle() {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage('Browser Session is not active — start recording first.');
        return;
    }
    const page = BrowserManager.getExistingPage();
    if (!page || page.isClosed()) {
        vscode.window.showWarningMessage('No browser page is open.');
        return;
    }
    const title = await page.title();
    handleBrowserStep({
        type: 'assert_title',
        assertionValue: title,
        description: `Assert page title equals "${title}"`,
    });
    vscode.window.showInformationMessage(`✅ Asserted page title: "${title}"`);
    if (outputChannel) outputChannel.appendLine(`[Step Recorder] Assert page title: "${title}"`);
}

/**
 * Assert: Page URL — captures current URL.
 */
export async function assertPageUrl() {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage('Browser Session is not active — start recording first.');
        return;
    }
    const page = BrowserManager.getExistingPage();
    if (!page || page.isClosed()) {
        vscode.window.showWarningMessage('No browser page is open.');
        return;
    }
    const url = page.url();
    const matchType = await vscode.window.showQuickPick(
        [
            { label: 'Exact match', value: 'exact' },
            { label: 'Contains', value: 'contains' },
        ],
        { placeHolder: `Current URL: ${url} — How should it be matched?` },
    );
    if (!matchType) return;
    handleBrowserStep({
        type: 'assert_url',
        assertionValue: url,
        assertionMatchType: matchType.value,
        description: `Assert page URL ${matchType.value === 'exact' ? 'equals' : 'contains'} "${url}"`,
    });
    vscode.window.showInformationMessage(`✅ Asserted page URL (${matchType.value}): "${url}"`);
    if (outputChannel) outputChannel.appendLine(`[Step Recorder] Assert URL (${matchType.value}): "${url}"`);
}

/**
 * Assert: Full Page Snapshot — captures all visible text on the page.
 */
export async function assertPageSnapshot() {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage('Browser Session is not active — start recording first.');
        return;
    }
    const page = BrowserManager.getExistingPage();
    if (!page || page.isClosed()) {
        vscode.window.showWarningMessage('No browser page is open.');
        return;
    }

    const textToFind = await vscode.window.showInputBox({
        prompt: 'Enter text that should be present on the page',
        placeHolder: 'e.g. Welcome back, John',
        ignoreFocusOut: true,
    });
    if (!textToFind) return;

    handleBrowserStep({
        type: 'assert_snapshot',
        assertionValue: textToFind,
        description: `Assert page contains text "${textToFind}"`,
    });
    vscode.window.showInformationMessage(`✅ Asserted page contains: "${textToFind}"`);
    if (outputChannel) outputChannel.appendLine(`[Step Recorder] Assert page text: "${textToFind}"`);
}

/**
 * Called from the browser-injected event wiring when an assertion-mode click
 * lands on an element.  Augments the event data with assertion metadata.
 */
async function processAssertionClick(eventData: any): Promise<any | null> {
    const aType = pendingAssertionType;
    if (!aType) return null;

    // Reset mode immediately so subsequent clicks are normal
    pendingAssertionType = null;
    const page = BrowserManager.getExistingPage();
    if (page && !page.isClosed()) {
        page.evaluate(`(() => { delete window.__webcureAssertMode; })();`).catch(() => {});
    }

    const label = eventData.label || eventData.accessibleName || eventData.text || eventData.tagName || 'element';
    const safeLabel = String(label).substring(0, 60);

    if (aType === 'assert_visible') {
        return {
            ...eventData,
            type: 'assert_visible',
            description: `Assert '${safeLabel}' is visible`,
        };
    }

    if (aType === 'assert_not_visible') {
        return {
            ...eventData,
            type: 'assert_not_visible',
            description: `Assert '${safeLabel}' is NOT visible`,
        };
    }

    if (aType === 'assert_text') {
        const rawText = eventData.text || '';
        // Let the user review and edit — raw innerText can be huge for containers
        const text = await vscode.window.showInputBox({
            prompt: `Text to assert on '${safeLabel}' (edit as needed)`,
            value: rawText.substring(0, 200).replace(/\n/g, ' ').trim(),
            ignoreFocusOut: true,
        });
        if (text === undefined) return null; // user cancelled
        return {
            ...eventData,
            type: 'assert_text',
            assertionValue: text,
            description: `Assert '${safeLabel}' contains text "${text.substring(0, 60)}"`,
        };
    }

    if (aType === 'assert_value') {
        // input_value() only works on <input>, <textarea>, <select>
        const tag = (eventData.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
            vscode.window.showWarningMessage(`Cannot assert value on <${eventData.tagName || 'element'}> — only works on input, textarea, and select elements. Use "Text" assertion instead.`);
            return null;
        }
        const value = eventData.value || '';
        return {
            ...eventData,
            type: 'assert_value',
            assertionValue: value,
            description: `Assert '${safeLabel}' has value "${String(value).substring(0, 60)}"`,
        };
    }

    if (aType === 'assert_checked') {
        return {
            ...eventData,
            type: 'assert_checked',
            description: `Assert '${safeLabel}' is checked`,
        };
    }

    if (aType === 'assert_not_checked') {
        return {
            ...eventData,
            type: 'assert_not_checked',
            description: `Assert '${safeLabel}' is NOT checked`,
        };
    }

    if (aType === 'assert_enabled') {
        return {
            ...eventData,
            type: 'assert_enabled',
            description: `Assert '${safeLabel}' is enabled`,
        };
    }

    if (aType === 'assert_disabled') {
        return {
            ...eventData,
            type: 'assert_disabled',
            description: `Assert '${safeLabel}' is disabled`,
        };
    }

    if (aType === 'assert_count') {
        const countInput = await vscode.window.showInputBox({
            prompt: `How many '${safeLabel}' elements do you expect?`,
            placeHolder: 'e.g. 3',
            validateInput: v => (!v || isNaN(parseInt(v)) || parseInt(v) < 0) ? 'Enter a non-negative integer' : undefined,
            ignoreFocusOut: true,
        });
        if (!countInput) return null; // cancelled
        const count = parseInt(countInput);
        return {
            ...eventData,
            type: 'assert_count',
            assertionValue: count,
            description: `Assert count of '${safeLabel}' equals ${count}`,
        };
    }

    if (aType === 'assert_attribute') {
        const attrName = await vscode.window.showInputBox({
            prompt: `Attribute name to check on '${safeLabel}'`,
            placeHolder: 'e.g. class, href, data-status',
            ignoreFocusOut: true,
        });
        if (!attrName) return null;
        // Read the current attribute value from the element
        let currentValue = '';
        if (page && !page.isClosed() && eventData.locators?.length) {
            try {
                const locators = eventData.locators;
                const bestLoc = [...locators].sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0))[0];
                const el = page.locator(bestLoc.strategy === 'css' ? bestLoc.value : `xpath=${bestLoc.value}`);
                currentValue = await el.getAttribute(attrName) || '';
            } catch { /* use empty */ }
        }
        const attrValue = await vscode.window.showInputBox({
            prompt: `Expected value for "${attrName}" attribute`,
            value: currentValue,
            ignoreFocusOut: true,
        });
        if (attrValue === undefined) return null; // Escape pressed
        return {
            ...eventData,
            type: 'assert_attribute',
            assertionAttribute: attrName,
            assertionValue: attrValue,
            description: `Assert '${safeLabel}' has ${attrName}="${attrValue}"`,
        };
    }

    return null;
}

export function generateStepsPythonScript(steps: any[], defaultWaitSeconds = 0): string {
    const lines: string[] = [];
    const timestamp = new Date().toISOString();
    const indent = '        ';

    lines.push('#!/usr/bin/env python3');
    lines.push('# Auto-generated by WebCure Step Recorder');
    lines.push(`# Recorded at: ${timestamp}`);
    lines.push('#');
    lines.push('# Prerequisites:');
    lines.push('#   pip install playwright');
    lines.push('#   playwright install chromium');
    lines.push('#');
    lines.push('# Run:  python3 test_recording.py');
    lines.push('');
    lines.push(PYTHON_HELPERS);
    lines.push('');
    lines.push('# ---------------------------------------------------------------------------');
    lines.push('# Recorded test flow');
    lines.push('# ---------------------------------------------------------------------------');
    lines.push('def test_recorded_flow():');
    lines.push('    with sync_playwright() as p:');
    lines.push('        browser = p.chromium.launch(headless=False)');
    lines.push('        page = browser.new_page()');
    lines.push('        _has_failure = False');
    lines.push('');

    let stepNum = 0;
    for (const step of steps) {
        if (step.type === 'close' && step.tagName === 'Browser') continue;
        stepNum++;
        const stepLines = stepToPythonLines(step, stepNum, indent);
        // Inject default wait between action steps (not after navigate / sleep / close / assertions)
        const isActionStep = defaultWaitSeconds > 0
            && step.type !== 'navigate'
            && step.type !== 'sleep'
            && step.type !== 'close'
            && !String(step.type).startsWith('assert_');
        if (isActionStep && stepLines.length > 0 && stepLines[stepLines.length - 1] === '') {
            stepLines.splice(stepLines.length - 1, 0, `${indent}time.sleep(${defaultWaitSeconds})  # default wait between steps`);
        }

        // Extract the comment line (first line starting with #) as description
        const commentLine = stepLines.find(l => l.trim().startsWith('# Step'));
        const desc = commentLine
            ? commentLine.trim().replace(/^# /, '').replace(/^Step \\d+:\\s*/, '')
            : `Step ${stepNum}`;
        const pyDesc = desc.replace(/'/g, "\\'");

        // Wrap step in try/except for pass/fail tracking
        lines.push(`${indent}try:`);
        // Re-indent step lines under try block
        for (const l of stepLines) {
            if (l === '') {
                // skip blank lines inside the try
            } else {
                lines.push(`    ${l}`);
            }
        }
        lines.push(`${indent}    _record_step(${stepNum}, '${pyDesc}', True)`);
        lines.push(`${indent}except Exception as _e:`);
        lines.push(`${indent}    _record_step(${stepNum}, '${pyDesc}', False, str(_e)[:200])`);
        lines.push(`${indent}    _has_failure = True`);
        lines.push('');
    }

    lines.push(`${indent}_print_summary()`);
    lines.push(`${indent}browser.close()`);
    lines.push(`${indent}if _has_failure:`);
    lines.push(`${indent}    sys.exit(1)`);
    lines.push('');
    lines.push('');
    lines.push('if __name__ == "__main__":');
    lines.push('    test_recorded_flow()');
    lines.push('');

    return lines.join('\n');
}
