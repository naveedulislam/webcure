// ---------------------------------------------------------------------------
// WebCure -- File-based command bridge for agent integration
// ---------------------------------------------------------------------------
//
// Enables AI agents (in Cursor, Antigravity, or any IDE) to control WebCure
// by writing JSON commands to a watched file. No MCP, no HTTP server, no
// Language Model Tools API required.
//
// Protocol:
//   Agent writes  ->  .webcure/input.json
//   Extension     ->  executes command via BrowserManager / tool instances
//   Extension     ->  writes result to .webcure/output.json
//   Extension     ->  deletes input.json (signals completion)
// ---------------------------------------------------------------------------

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { BRIDGE_DIR, BRIDGE_INPUT, BRIDGE_OUTPUT, BRIDGE_CLI } from '../constants';
import { BrowserManager } from '../browserManager';

// Recorder
import { startRecording, stopRecording, recordAction } from '../recorder/action-log';
import { generatePythonScript } from '../recorder/script-generator';
import { startStepRecorder, stopStepRecorder } from '../recorder/step-recorder';

// ---------------------------------------------------------------------------
// Tool instances -- set by extension.ts after tool registration
// ---------------------------------------------------------------------------

let toolInstances: Record<string, vscode.LanguageModelTool<any>> | null = null;

/**
 * Provide the bridge with tool instances created in extension.ts.
 */
export function setBridgeToolInstances(
    instances: Record<string, vscode.LanguageModelTool<any>>,
): void {
    toolInstances = instances;
}

// ---------------------------------------------------------------------------
// Bridge state
// ---------------------------------------------------------------------------

let watcher: fs.FSWatcher | null = null;
let bridgePath: string | null = null;
let processing = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the file bridge. Creates the `.webcure/` directory in the
 * workspace root and begins watching for `input.json`.
 */
export function startBridge(context: vscode.ExtensionContext): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        return; // No workspace open -- bridge is a no-op.
    }

    bridgePath = path.join(workspaceRoot, BRIDGE_DIR);

    // Create the bridge directory if it doesn't exist.
    if (!fs.existsSync(bridgePath)) {
        fs.mkdirSync(bridgePath, { recursive: true });
    }

    // Write the CLI helper script.
    writeCLIScript(bridgePath);

    // Add .webcure to .gitignore if not already present.
    ensureGitignore(workspaceRoot);

    // Clean up any stale files from a previous session.
    cleanStaleFiles(bridgePath);

    // Watch for input.json.
    watcher = fs.watch(bridgePath, async (eventType, filename) => {
        if (filename === BRIDGE_INPUT && !processing) {
            await sleep(50);
            await processCommand(bridgePath!);
        }
    });

    // Check if input.json already exists.
    const inputPath = path.join(bridgePath, BRIDGE_INPUT);
    if (fs.existsSync(inputPath)) {
        processCommand(bridgePath);
    }
}

/**
 * Stop the file bridge and clean up.
 */
export function stopBridge(): void {
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    bridgePath = null;
}

// ---------------------------------------------------------------------------
// Command processing
// ---------------------------------------------------------------------------

interface BridgeCommand {
    command: string;
    args?: Record<string, unknown>;
}

interface BridgeResult {
    status: 'ok' | 'error';
    command: string;
    result?: Record<string, unknown>;
    error?: string;
}

async function processCommand(dir: string): Promise<void> {
    if (processing) {
        return;
    }
    processing = true;

    const inputPath = path.join(dir, BRIDGE_INPUT);
    const outputPath = path.join(dir, BRIDGE_OUTPUT);

    try {
        if (!fs.existsSync(inputPath)) {
            processing = false;
            return;
        }

        const raw = fs.readFileSync(inputPath, 'utf-8');
        let cmd: BridgeCommand;

        try {
            cmd = JSON.parse(raw);
        } catch {
            writeResult(outputPath, {
                status: 'error',
                command: 'unknown',
                error: `Invalid JSON in ${BRIDGE_INPUT}: ${raw.slice(0, 200)}`,
            });
            safeDelete(inputPath);
            processing = false;
            return;
        }

        if (!cmd.command) {
            writeResult(outputPath, {
                status: 'error',
                command: 'unknown',
                error: 'Missing "command" field in input JSON.',
            });
            safeDelete(inputPath);
            processing = false;
            return;
        }

        // Delete input.json immediately so the agent knows we received it.
        safeDelete(inputPath);

        // Route and execute.
        const result = await executeCommand(cmd.command, cmd.args ?? {});
        writeResult(outputPath, result);

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        writeResult(outputPath, {
            status: 'error',
            command: 'unknown',
            error: `Bridge error: ${message}`,
        });
        safeDelete(inputPath);
    } finally {
        processing = false;
    }
}

// ---------------------------------------------------------------------------
// Command router
// ---------------------------------------------------------------------------

// Map bridge command names to tool instance keys and param transforms.
// For commands that map 1:1 to a Language Model Tool, we invoke the tool.
// For commands unique to the bridge (scroll, recording, etc.) we handle directly.

const BRIDGE_TO_TOOL: Record<string, { tool: string; mapArgs?: (args: Record<string, unknown>) => Record<string, unknown> }> = {
    navigate:       { tool: 'navigate', mapArgs: a => ({ url: a.url || a.target, waitUntil: a.waitUntil }) },
    click:          { tool: 'click', mapArgs: a => ({ ref: a.ref, text: a.target as string, selector: a.selector, element: a.target || a.element, toLeftOf: a.leftOf || a.toLeftOf, toRightOf: a.rightOf || a.toRightOf, above: a.above, below: a.below }) },
    hover:          { tool: 'hover', mapArgs: a => ({ ref: a.ref, text: a.target as string, selector: a.selector, element: a.target || a.element, toLeftOf: a.leftOf || a.toLeftOf, toRightOf: a.rightOf || a.toRightOf, above: a.above, below: a.below }) },
    typeText:       { tool: 'type', mapArgs: a => ({ ref: a.ref, text: a.into, selector: a.selector, value: a.text, element: a.into || a.element, submit: a.submit, toLeftOf: a.leftOf || a.toLeftOf, toRightOf: a.rightOf || a.toRightOf, above: a.above, below: a.below }) },
    typeFromFile:   { tool: 'typeFromFile', mapArgs: a => ({ filePath: a.filePath, ref: a.ref, text: a.text, selector: a.selector, submit: a.submit, element: a.element }) },
    pressKey:       { tool: 'pressKey', mapArgs: a => ({ key: a.key || a.target }) },
    selectOption:   { tool: 'select', mapArgs: a => ({ ref: a.ref, text: a.comboBox, selector: a.selector, values: [a.value], element: a.comboBox || a.element, toLeftOf: a.leftOf || a.toLeftOf, toRightOf: a.rightOf || a.toRightOf, above: a.above, below: a.below }) },
    fillForm:       { tool: 'fillForm', mapArgs: a => ({ fields: a.fields }) },
    screenshot:     { tool: 'screenshot', mapArgs: a => ({ ref: a.ref, outputPath: a.outputPath || a.filename || a.path, type: a.type, fullPage: a.fullPage, element: a.element }) },
    consoleMessages:{ tool: 'consoleMessages', mapArgs: a => ({ onlyErrors: a.onlyErrors }) },
    networkRequests:{ tool: 'networkRequests' },
    handleDialog:   { tool: 'handleDialog', mapArgs: a => ({ accept: a.accept ?? true, promptText: a.promptText }) },
    uploadFile:     { tool: 'fileUpload', mapArgs: a => ({ paths: a.paths, selector: a.selector }) },
    evaluate:       { tool: 'evaluate', mapArgs: a => ({ function: a.expression, ref: a.ref, element: a.target || a.element }) },
    navigateBack:   { tool: 'navigateBack' },
    goBack:         { tool: 'navigateBack' },
    snapshot:       { tool: 'snapshot' },
    find:           { tool: 'find', mapArgs: a => ({ text: a.text, selector: a.selector, near: a.near, toLeftOf: a.toLeftOf, toRightOf: a.toRightOf, above: a.above, below: a.below, index: a.index }) },
    interact:       { tool: 'interact', mapArgs: a => ({ action: a.action, ref: a.ref, text: a.text, selector: a.selector, value: a.value, toLeftOf: a.toLeftOf, toRightOf: a.toRightOf, above: a.above, below: a.below }) },
    scrapeMenu:     { tool: 'scrapeMenu', mapArgs: a => ({ menuSelector: a.menuSelector, containerSelector: a.containerSelector, expanderSelector: a.expanderSelector, expandTimeout: a.expandTimeout, maxDepth: a.maxDepth, includeUrls: a.includeUrls, outputPath: a.outputPath }) },
    scrapePage:     { tool: 'scrapePage', mapArgs: a => ({ includeFormFields: a.includeFormFields, includeTables: a.includeTables, includeFilters: a.includeFilters, maxTableRows: a.maxTableRows, formSelector: a.formSelector, tableSelector: a.tableSelector, outputPath: a.outputPath }) },
    drag:           { tool: 'drag', mapArgs: a => ({ startRef: a.startRef || a.source, startElement: a.startElement || a.source, endRef: a.endRef || a.target, endElement: a.endElement || a.target }) },
    dragTo:         { tool: 'drag', mapArgs: a => ({ startRef: a.source, startElement: a.source, endRef: a.target, endElement: a.target }) },
    close:          { tool: 'close' },
    closeBrowser:   { tool: 'close' },
    tabs:           { tool: 'tabs', mapArgs: a => ({ action: a.action || 'list', index: a.index }) },
    listTabs:       { tool: 'tabs', mapArgs: () => ({ action: 'list' }) },
    newTab:         { tool: 'tabs', mapArgs: a => ({ action: 'new' }) },
    closeTab:       { tool: 'tabs', mapArgs: a => ({ action: 'close', index: a.index }) },
    selectTab:      { tool: 'tabs', mapArgs: a => ({ action: 'select', index: a.index }) },
    waitForText:    { tool: 'waitFor', mapArgs: a => ({ text: a.text, textGone: a.textGone, timeout: a.timeout }) },
    waitForElement: { tool: 'waitForElement', mapArgs: a => ({ ref: a.ref, text: a.target || a.text, selector: a.selector, state: a.state || 'visible', timeout: a.timeout, element: a.element, toLeftOf: a.toLeftOf, toRightOf: a.toRightOf, above: a.above, below: a.below }) },
    wait:           { tool: 'waitFor', mapArgs: a => ({ time: typeof a.ms === 'number' ? a.ms / 1000 : a.time }) },
    resize:         { tool: 'resize', mapArgs: a => ({ preset: a.preset, width: a.width, height: a.height }) },
    resizeBrowser:  { tool: 'resize', mapArgs: a => ({ preset: a.preset, width: a.width, height: a.height }) },
    fullscreenBrowser: { tool: 'resize', mapArgs: () => ({ preset: 'fullscreen' }) },
    extract:        { tool: 'extract', mapArgs: a => ({ selector: a.selector, maxLength: a.maxLength, trimWhitespace: a.trimWhitespace }) },
    install:        { tool: 'install' },
};

export async function executeCommand(
    command: string,
    args: Record<string, unknown>,
): Promise<BridgeResult> {
    try {
        // ---- Commands handled via Language Model Tool instances ----
        const mapping = BRIDGE_TO_TOOL[command];
        if (mapping && toolInstances) {
            const tool = (toolInstances as any)[mapping.tool];
            if (tool) {
                const params = mapping.mapArgs ? mapping.mapArgs(args) : args;
                const output = await invokeToolAsText(tool, params);
                recordAction(command, args, 'agent');
                return ok(command, { output });
            }
        }

        // ---- Commands unique to the bridge (no tool equivalent) ----
        switch (command) {
            case 'launchBrowser': {
                // Use BrowserManager to ensure a page is open.
                const page = await BrowserManager.getPage();
                if (args.url) {
                    await page.goto(args.url as string, { waitUntil: 'load' });
                }
                const url = page.url();
                const title = await page.title();
                const viewport = page.viewportSize() ?? { width: 0, height: 0 };
                return ok(command, { url, title, viewport });
            }

            case 'scrollDown': {
                const page = await BrowserManager.getPage();
                const pixels = (args.pixels as number) ?? 500;
                await page.evaluate((px: number) => window.scrollBy(0, px), pixels);
                recordAction(command, { pixels }, 'agent');
                return ok(command, { scrolled: 'down', pixels });
            }
            case 'scrollUp': {
                const page = await BrowserManager.getPage();
                const pixels = (args.pixels as number) ?? 500;
                await page.evaluate((px: number) => window.scrollBy(0, -px), pixels);
                recordAction(command, { pixels }, 'agent');
                return ok(command, { scrolled: 'up', pixels });
            }
            case 'scrollRight': {
                const page = await BrowserManager.getPage();
                const pixels = (args.pixels as number) ?? 300;
                await page.evaluate((px: number) => window.scrollBy(px, 0), pixels);
                recordAction(command, { pixels }, 'agent');
                return ok(command, { scrolled: 'right', pixels });
            }
            case 'scrollLeft': {
                const page = await BrowserManager.getPage();
                const pixels = (args.pixels as number) ?? 300;
                await page.evaluate((px: number) => window.scrollBy(-px, 0), pixels);
                recordAction(command, { pixels }, 'agent');
                return ok(command, { scrolled: 'left', pixels });
            }

            case 'doubleClick': {
                if (args.ref) {
                    const el = BrowserManager.getElementByRef(args.ref as string);
                    if (!el) {
                        return { status: 'error', command, error: `Element ref "${args.ref}" not found.` };
                    }
                    await el.dblclick();
                    recordAction(command, { ref: args.ref }, 'agent');
                    return ok(command, { doubleClickedRef: args.ref });
                }
                const page = await BrowserManager.getPage();
                const target = args.target as string;
                if (target) {
                    await page.dblclick(`text=${target}`);
                }
                recordAction(command, args, 'agent');
                return ok(command, { doubleClicked: target });
            }

            case 'rightClick': {
                if (args.ref) {
                    const el = BrowserManager.getElementByRef(args.ref as string);
                    if (!el) {
                        return { status: 'error', command, error: `Element ref "${args.ref}" not found.` };
                    }
                    await el.click({ button: 'right' });
                    recordAction(command, { ref: args.ref }, 'agent');
                    return ok(command, { rightClickedRef: args.ref });
                }
                const page = await BrowserManager.getPage();
                const target = args.target as string;
                if (target) {
                    await page.click(`text=${target}`, { button: 'right' });
                }
                recordAction(command, args, 'agent');
                return ok(command, { rightClicked: target });
            }

            case 'refresh': {
                const page = await BrowserManager.getPage();
                await page.reload();
                recordAction(command, {}, 'agent');
                return ok(command, { refreshed: true });
            }

            case 'goForward': {
                const page = await BrowserManager.getPage();
                await page.goForward();
                recordAction(command, {}, 'agent');
                return ok(command, { wentForward: true });
            }

            case 'switchWindow': {
                const title = args.title as string;
                const tabs = await BrowserManager.listTabs();
                const match = tabs.find(t => t.title.includes(title));
                if (match) {
                    await BrowserManager.selectTab(tabs.indexOf(match) + 1);
                    return ok(command, { switchedTo: title });
                }
                return { status: 'error', command, error: `No tab with title containing "${title}"` };
            }

            case 'getPageInfo': {
                try {
                    const page = await BrowserManager.getPage();
                    const url = page.url();
                    const title = await page.title();
                    return ok(command, { running: true, url, title });
                } catch {
                    return ok(command, { running: false });
                }
            }

            case 'getPageContent': {
                const page = await BrowserManager.getPage();
                const content = await page.content();
                return ok(command, { html: content.slice(0, 50_000) });
            }

            case 'getPageText': {
                const page = await BrowserManager.getPage();
                const text = await page.innerText('body');
                return ok(command, { text: text.slice(0, 50_000) });
            }

            case 'getAccessibilityTree': {
                // Same as snapshot tool
                if (toolInstances?.snapshot) {
                    const output = await invokeToolAsText(toolInstances.snapshot, {});
                    return ok(command, { tree: output });
                }
                return { status: 'error', command, error: 'Snapshot tool not available.' };
            }

            case 'highlight': {
                const target = args.target as string;
                if (!target) {
                    return { status: 'error', command, error: 'Missing required argument: "target"' };
                }
                const page = await BrowserManager.getPage();
                await page.evaluate((sel: string) => {
                    const el = document.querySelector(sel) || Array.from(document.querySelectorAll('*')).find(e => e.textContent?.includes(sel));
                    if (el instanceof HTMLElement) {
                        el.style.outline = '3px solid red';
                        el.style.outlineOffset = '2px';
                    }
                }, target);
                recordAction(command, { target }, 'agent');
                return ok(command, { highlighted: target });
            }

            case 'getDialogText': {
                const dialogInfo = BrowserManager.getLastDialogInfo();
                return ok(command, {
                    text: dialogInfo?.message ?? null,
                    type: dialogInfo?.type ?? null,
                    handled: dialogInfo?.handled ?? false,
                    response: dialogInfo?.response ?? null,
                });
            }

            case 'setDialogAction': {
                const accept = args.accept !== false;
                BrowserManager.setNextDialogAction(accept, args.promptText as string | undefined);
                return ok(command, { configured: true, willAccept: accept });
            }

            case 'startRecording':
                startRecording();
                return ok(command, { recording: true });

            case 'stopRecording': {
                const actions = stopRecording();
                const script = actions.length > 0 ? generatePythonScript(actions) : null;
                return ok(command, { actionCount: actions.length, script });
            }

            case 'startStepRecorder': {
                const url = args.url as string | undefined;
                await startStepRecorder(url);
                return ok(command, { recording: true, url: url || null });
            }

            case 'stopStepRecorder': {
                await stopStepRecorder();
                return ok(command, { recording: false });
            }

            case 'restartExtensionHost': {
                // Restart the VS Code extension host so newly installed VSIX
                // changes take effect without a full window reload.
                await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
                return ok(command, { restarted: true });
            }

            case 'runScript': {
                const filePath = args.file as string;
                if (!filePath) {
                    return { status: 'error', command, error: 'Missing required argument: "file"' };
                }
                // Execute script by reading JSON and running steps
                const raw = fs.readFileSync(filePath, 'utf-8');
                const script = JSON.parse(raw);
                const steps = script.steps || [];
                const results: unknown[] = [];
                for (const step of steps) {
                    const stepResult = await executeCommand(step.command || step.tool, step.args || step.params || {});
                    results.push(stepResult);
                    if (stepResult.status === 'error' && script.stopOnError !== false) {
                        break;
                    }
                }
                return ok(command, { steps: results.length, results });
            }

            default:
                return {
                    status: 'error',
                    command,
                    error: `Unknown command: "${command}".`,
                };
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'error', command, error: message };
    }
}

// ---------------------------------------------------------------------------
// Helper: invoke a Language Model Tool and extract text output
// ---------------------------------------------------------------------------

async function invokeToolAsText(
    tool: vscode.LanguageModelTool<any>,
    params: Record<string, unknown>,
): Promise<string> {
    const result = await tool.invoke(
        { input: params, toolInvocationToken: undefined as any },
        new vscode.CancellationTokenSource().token,
    );
    let text = '';
    if (result?.content) {
        for (const part of result.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            }
        }
    }
    return text;
}

// ---------------------------------------------------------------------------
// CLI script generator
// ---------------------------------------------------------------------------

function writeCLIScript(dir: string): void {
    const cliPath = path.join(dir, BRIDGE_CLI);
    // Look for cli-template.js in the same directory as this compiled file
    const candidates = [
        path.join(__dirname, 'cli-template.js'),           // out/src/bridge/cli-template.js (copied by compile script)
        path.join(__dirname, '..', '..', '..', 'src', 'bridge', 'cli-template.js'), // dev: repo root/src/bridge/
    ];
    const templatePath = candidates.find(p => fs.existsSync(p));
    if (templatePath) {
        fs.copyFileSync(templatePath, cliPath);
        fs.chmodSync(cliPath, 0o755);
    } else {
        const minimal = '#!/usr/bin/env node\nconsole.error("CLI template not found. Reinstall the extension.");\nprocess.exit(1);\n';
        fs.writeFileSync(cliPath, minimal, { mode: 0o755 });
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(command: string, result: Record<string, unknown>): BridgeResult {
    return { status: 'ok', command, result };
}

function writeResult(outputPath: string, result: BridgeResult): void {
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
}

function safeDelete(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Ignore -- file may already be gone.
    }
}

function cleanStaleFiles(dir: string): void {
    safeDelete(path.join(dir, BRIDGE_INPUT));
    safeDelete(path.join(dir, BRIDGE_OUTPUT));
}

function ensureGitignore(workspaceRoot: string): void {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const entry = BRIDGE_DIR;

    try {
        if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, 'utf-8');
            if (content.includes(entry)) {
                return;
            }
            const separator = content.endsWith('\n') ? '' : '\n';
            fs.appendFileSync(gitignorePath, `${separator}${entry}\n`);
        } else {
            fs.writeFileSync(gitignorePath, `${entry}\n`);
        }
    } catch {
        // Non-critical.
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
