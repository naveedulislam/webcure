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

let isRecordingSteps = false;
let currentMarkdownPath: string | undefined = undefined;
let stepCounter = 0;
let outputChannel: vscode.OutputChannel | undefined;
let stepQueue: Promise<void> = Promise.resolve();

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
function initMarkdownLog(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error("A workspace must be open to save the step recording log.");
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const timestamp = getTimestamp();
    const folderName = `WebCure_Steps_${timestamp}`;
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
    if (!isRecordingSteps || !currentMarkdownPath) return;

    // Enqueue the step to prevent race conditions on stepCounter and file writes
    stepQueue = stepQueue.then(async () => {
        if (!isRecordingSteps || !currentMarkdownPath) return;

        try {
            // For 'close' events, skip screenshot — the page is already gone.
            // Do NOT call BrowserManager.getPage() here as it would open a new browser.
            const isBrowserClose = eventData.type === 'close' && eventData.tagName === 'Browser';

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

            if (!isBrowserClose) {
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
                : `*(No screenshot — browser was closed)*`;
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
export async function startStepRecorder(initialUrl?: string) {
    if (isRecordingSteps) {
        vscode.window.showInformationMessage("Step Recording is already active.");
        return;
    }

    try {
        const logDir = initMarkdownLog();
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

                    // CHANGE (typing / input)
                    document.addEventListener('change', (e) => {
                        const target = e.target;
                        const el = engine.resolveInteractiveElement(target) || target;
                        const data = buildEventData(el, 'type', { value: target.value });
                        if (data) queueEvent(data);
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
        }

        isRecordingSteps = true;
        vscode.window.showInformationMessage(`Recording started! Log directory: ${logDir}`);

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
                text: `Navigated to ${initialUrl}`
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
 * Stops the step recorder and opens the generated Markdown file in the editor.
 */
export async function stopStepRecorder() {
    if (!isRecordingSteps) {
        vscode.window.showWarningMessage("Step Recording is not currently active.");
        return;
    }

    isRecordingSteps = false;

    if (outputChannel) {
        outputChannel.appendLine(`\n${'='.repeat(60)}`);
        outputChannel.appendLine(`[WebCure Step Recorder] STOPPED`);
        outputChannel.appendLine(`Total steps recorded: ${stepCounter}`);
        outputChannel.appendLine(`${'='.repeat(60)}\n`);
    }

    if (currentMarkdownPath && fs.existsSync(currentMarkdownPath)) {
        vscode.window.showInformationMessage(`Recording stopped. Opening log file: ${currentMarkdownPath}`);

        try {
            const uri = vscode.Uri.file(currentMarkdownPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            // Open markdown preview
            await vscode.commands.executeCommand('markdown.showPreview', uri);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to open markdown log: ${error.message}`);
        }
    }

    currentMarkdownPath = undefined;
    stepCounter = 0;
}
