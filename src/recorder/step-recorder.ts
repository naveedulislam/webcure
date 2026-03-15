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
            const mdEntry = `
### Step ${currentStep}
**Action:** ${actionText}
<!-- Details: 
  tagName: ${eventData.tagName || ''}
  role: ${eventData.role || ''}
  category: ${eventData.category || ''}
  id: ${eventData.id || ''}
  cssSelector: ${eventData.cssSelector || ''}
  xpath: ${eventData.xpath || ''}
  locators: ${JSON.stringify(eventData.locators || [])}
  context: ${JSON.stringify(eventData.context || {})}
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
        vscode.window.showInformationMessage("Step Recording is already active.");
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

                    function flushEvents() {
                        eventBuffer.sort((a, b) => {
                            if (a.type === 'type' && b.type === 'keydown') return -1;
                            if (a.type === 'keydown' && b.type === 'type') return 1;
                            return 0;
                        });
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
                        const data = buildEventData(el, 'click');
                        if (data) queueEvent(data);
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
        vscode.window.showErrorMessage(`Failed to start Step Recorder: ${error.message}`);
        isRecordingSteps = false;
    }
}

/**
 * Stops the step recorder and opens the generated output file(s).
 */
export async function stopStepRecorder() {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage('Step Recording is not currently active.');
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
    const s = String(val ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

    const comment = step.description
        || (type === 'navigate' ? `Navigate to ${url || text || ''}` : `Step ${stepNum}`);
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
import time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeoutError

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
`;

export function isStepRecording(): boolean {
    return isRecordingSteps;
}

/**
 * Records an optional sleep/pause step during an active recording.
 */
export async function insertSleepStep() {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage('Step Recording is not active — start recording first.');
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
    lines.push('');

    let stepNum = 0;
    for (const step of steps) {
        if (step.type === 'close' && step.tagName === 'Browser') continue;
        stepNum++;
        const stepLines = stepToPythonLines(step, stepNum, indent);
        // Inject default wait between action steps (not after navigate / sleep / close)
        const isActionStep = defaultWaitSeconds > 0
            && step.type !== 'navigate'
            && step.type !== 'sleep'
            && step.type !== 'close';
        if (isActionStep && stepLines.length > 0 && stepLines[stepLines.length - 1] === '') {
            stepLines.splice(stepLines.length - 1, 0, `${indent}time.sleep(${defaultWaitSeconds})  # default wait between steps`);
        }
        for (const l of stepLines) lines.push(l);
    }

    lines.push(`${indent}browser.close()`);
    lines.push('');
    lines.push('');
    lines.push('if __name__ == "__main__":');
    lines.push('    test_recorded_flow()');
    lines.push('');

    return lines.join('\n');
}
