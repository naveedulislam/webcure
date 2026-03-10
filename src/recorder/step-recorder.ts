import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserManager } from '../browserManager';
import { Page } from 'playwright-core';

declare global {
    interface Window {
        recordStep?: (eventData: any) => void;
        __webcureStepRecorderAttached?: boolean;
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
 */
function formatActionDescription(eventData: any): string {
    const { type, tagName, text, placeholder, ariaLabel, value, key, title, name, id, labelText, buttonText, inputType } = eventData || {};

    // Determine the best name for the element
    // For buttons, prefer buttonText (the button's own value/label) over labelText (nearby label heuristic)
    const isButtonElement = (tagName && tagName.toLowerCase() === 'button') || 
        (tagName && tagName.toLowerCase() === 'input' && ['submit', 'button', 'reset'].includes((inputType || '').toLowerCase()));
    const elementName = isButtonElement
        ? (buttonText || text || ariaLabel || labelText || title || placeholder || name || id || (tagName ? tagName.toLowerCase() : 'element'))
        : (labelText || buttonText || text || ariaLabel || title || placeholder || name || id || (tagName ? tagName.toLowerCase() : 'element'));
    let safeName = String(elementName).replace(/\s+/g, ' ').trim().substring(0, 50);

    // Remove trailing colons often found in heuristic label lookups (e.g. "Username:")
    safeName = safeName.replace(/:$/, '').trim();

    const lowerTag = tagName ? tagName.toLowerCase() : '';
    const isButton = lowerTag === 'button' || (lowerTag === 'input' && ['submit', 'button', 'reset'].includes((inputType || '').toLowerCase()));
    const isInput = lowerTag === 'input' || lowerTag === 'textarea';
    const tagDesc = isButton ? 'button' : isInput ? 'input' : lowerTag;

    if (type === 'click') {
        return `Clicked on ${tagDesc} '${safeName}'`;
    } else if (type === 'type') {
        const obscuredValue = lowerTag === 'input' && inputType === 'password'
            ? '********'
            : value;
        return `Typed '${obscuredValue}' into '${safeName}'`;
    } else if (type === 'keydown' && key === 'Enter') {
        return `Pressed 'Enter' on '${safeName}'`;
    }

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
                const page = await BrowserManager.getPage();

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

            // 3. Append to Markdown
            const screenshotMarkdown = screenshotTaken
                ? `![Screenshot for Step ${currentStep}](./${screenshotName})`
                : `*(No screenshot — browser was closed)*`;
            const mdEntry = `
### Step ${currentStep}
**Action:** ${actionText}
<!-- Details: 
  tagName: ${eventData.tagName || ''}
  id: ${eventData.id || ''}
  cssSelector: ${eventData.cssSelector || ''}
  xpath: ${eventData.xpath || ''}
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

            // Inject tracking script that attaches to all future navigations in this context
            await page.addInitScript(`
                (() => {
                    if (window.__webcureStepRecorderAttached) return;
                    window.__webcureStepRecorderAttached = true;

                    function getCssSelector(el) {
                        if (!el || el.nodeType !== 1) return '';
                        if (el.id) return '#' + CSS.escape(el.id);
                        let path = [];
                        while (el && el.nodeType === 1 && el.nodeName.toLowerCase() !== 'html') {
                            let selector = el.nodeName.toLowerCase();
                            if (el.id) {
                                selector += '#' + CSS.escape(el.id);
                                path.unshift(selector);
                                break;
                            } else {
                                let sib = el, nth = 1;
                                while (sib = sib.previousElementSibling) {
                                    if (sib.nodeName.toLowerCase() === selector) nth++;
                                }
                                if (nth !== 1) selector += ":nth-of-type(" + nth + ")";
                            }
                            path.unshift(selector);
                            el = el.parentNode;
                        }
                        return path.join(' > ');
                    }

                    function getXPath(el) {
                        if (!el || el.nodeType !== 1) return '';
                        if (el.id) return '//*[@id="' + el.id + '"]';
                        let parts = [];
                        while (el && el.nodeType === 1) {
                            let nbOfPreviousSiblings = 0;
                            let hasNextSiblings = false;
                            let sibling = el.previousSibling;
                            while (sibling) {
                                if (sibling.nodeType !== Node.DOCUMENT_TYPE_NODE && sibling.nodeName === el.nodeName) {
                                    nbOfPreviousSiblings++;
                                }
                                sibling = sibling.previousSibling;
                            }
                            sibling = el.nextSibling;
                            while (sibling) {
                                if (sibling.nodeName === el.nodeName) {
                                    hasNextSiblings = true;
                                    break;
                                }
                                sibling = sibling.nextSibling;
                            }
                            let prefix = el.prefix ? el.prefix + ':' : '';
                            let nth = nbOfPreviousSiblings || hasNextSiblings ? '[' + (nbOfPreviousSiblings + 1) + ']' : '';
                            parts.push(prefix + el.localName + nth);
                            el = el.parentNode;
                        }
                        return parts.length ? '//' + parts.reverse().join('/') : '';
                    }

                    function extractElementIdentifier(el) {
                        let labelText = '';
                        if (el.id) {
                            try {
                                const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                                if (label) labelText = label.innerText ? label.innerText.trim() : '';
                            } catch (e) {}
                        }
                        if (!labelText) {
                            const parentLabel = el.closest('label');
                            if (parentLabel && parentLabel.innerText) {
                                labelText = parentLabel.innerText.trim();
                            }
                        }
                        // Only apply table cell and previous sibling heuristics for input/textarea/select elements
                        const isInputNode = ['input', 'textarea', 'select'].includes(el.tagName ? el.tagName.toLowerCase() : '');
                        
                        // Heuristic: lookup previous table cell for text!
                        if (!labelText && isInputNode) {
                            const td = el.closest('td');
                            if (td) {
                                let prev = td.previousElementSibling;
                                while (prev && prev.tagName.toLowerCase() === 'td') {
                                    if (prev.innerText && prev.innerText.trim()) {
                                        labelText = prev.innerText.trim();
                                        break;
                                    }
                                    prev = prev.previousElementSibling;
                                }
                            }
                        }
                        // Heuristic: previous sibling text element
                        if (!labelText && isInputNode && el.previousElementSibling) {
                            const tag = el.previousElementSibling.tagName.toLowerCase();
                            if (['span', 'label', 'div', 'p', 'b', 'strong'].includes(tag)) {
                                const txt = el.previousElementSibling.innerText ? el.previousElementSibling.innerText.trim() : '';
                                if (txt && txt.length < 50) labelText = txt;
                            }
                        }
                        // Heuristic: previous raw text node
                        if (!labelText && isInputNode && el.previousSibling && el.previousSibling.nodeType === Node.TEXT_NODE) {
                            const txt = el.previousSibling.textContent.trim();
                            if (txt && txt.length < 50) labelText = txt;
                        }

                        let buttonText = '';
                        const tagNameLower = el.tagName ? el.tagName.toLowerCase() : '';
                        const inputType = el.getAttribute('type') || '';
                        
                        if (tagNameLower === 'input' && ['submit', 'button', 'reset'].includes(inputType.toLowerCase())) {
                            buttonText = el.value || '';
                        }

                        return {
                            tagName: el.tagName || '',
                            text: el.innerText ? el.innerText.trim() : '',
                            placeholder: el.getAttribute('placeholder') || '',
                            ariaLabel: el.getAttribute('aria-label') || '',
                            title: el.getAttribute('title') || '',
                            name: el.getAttribute('name') || '',
                            id: el.getAttribute('id') || '',
                            inputType: inputType,
                            labelText: labelText,
                            buttonText: buttonText,
                            cssSelector: getCssSelector(el),
                            xpath: getXPath(el)
                        };
                    }

                    // Event buffer for ordering 'type' before 'keydown(Enter)'
                    let eventBuffer = [];
                    let flushTimeout = null;

                    function flushEvents() {
                        // Sort so that 'type' events come before 'keydown' events for the same tick
                        eventBuffer.sort((a, b) => {
                            if (a.type === 'type' && b.type === 'keydown') return -1;
                            if (a.type === 'keydown' && b.type === 'type') return 1;
                            return 0;
                        });

                        eventBuffer.forEach(ev => window.recordStep(ev));
                        eventBuffer = [];
                        flushTimeout = null;
                    }

                    function queueEvent(eventPayload) {
                        eventBuffer.push(eventPayload);
                        if (!flushTimeout) {
                            flushTimeout = setTimeout(flushEvents, 50);
                        }
                    }

                    // Listen for MOUSE CLICKS
                    document.addEventListener('click', (e) => {
                        // Avoid triggering on purely layout clicks if it's not a button/link/input/etc
                        // But for simplicity, we capture all clicks that reach an interactive element or have text
                        const target = e.target;
                        const identifier = extractElementIdentifier(target);
                        
                        // Ignore pure document/body clicks unless we want them
                        if (target === document.body || target === document.documentElement) return;

                        queueEvent({
                            type: 'click',
                            ...identifier
                        });
                    }, true);

                    // Listen for TYPING / INPUT CHANGES
                    document.addEventListener('change', (e) => {
                        const target = e.target;
                        const identifier = extractElementIdentifier(target);
                        
                        queueEvent({
                            type: 'type',
                            value: target.value,
                            ...identifier
                        });
                    }, true);

                    // Listen for specific KEYS (like Enter)
                    document.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            const target = e.target;
                            const identifier = extractElementIdentifier(target);
                            
                            queueEvent({
                                type: 'keydown',
                                key: 'Enter',
                                ...identifier
                            });
                        }
                    }, true);
                })();
            `);
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
