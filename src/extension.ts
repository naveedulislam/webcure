/**
 * WebCure -- Hybrid browser automation extension
 *
 * Combines:
 *   - Language Model Tools (VS Code Copilot) from webexplorer
 *   - File-bridge for AI agent integration (Cursor, etc.) from webcursor
 *   - Python script recording
 */

import * as vscode from 'vscode';
import { BrowserManager } from './browserManager';
import { ApiServer } from './apiServer';
import {
	NavigateTool, ResizeTool, ExtractTool, ClickTool, HoverTool, TypeTool,
	TypeFromFileTool, WaitForTool, WaitForElementTool, SelectTool, FillFormTool,
	ScreenshotTool, CloseTool, ConsoleMessagesTool, DragTool, EvaluateTool,
	FileUploadTool, HandleDialogTool, NavigateBackTool, NetworkRequestsTool,
	PressKeyTool, SnapshotTool, TabsTool, InstallBrowserTool, FindTool,
	InteractTool, ScrapeMenuTool, ScrapePageTool,
} from './tools';
import { startBridge, stopBridge, setBridgeToolInstances } from './bridge/file-bridge';
import { startRecording, stopRecording, recordAction, isRecording, initRecorder } from './recorder/action-log';
import { generatePythonScript } from './recorder/script-generator';

// Output channel for test results
let outputChannel: vscode.OutputChannel;

// Tool instances -- shared between LM tools, API server, bridge, and test commands
const toolInstances = {
	navigate: new NavigateTool(),
	resize: new ResizeTool(),
	extract: new ExtractTool(),
	click: new ClickTool(),
	hover: new HoverTool(),
	type: new TypeTool(),
	typeFromFile: new TypeFromFileTool(),
	waitFor: new WaitForTool(),
	waitForElement: new WaitForElementTool(),
	select: new SelectTool(),
	fillForm: new FillFormTool(),
	screenshot: new ScreenshotTool(),
	close: new CloseTool(),
	consoleMessages: new ConsoleMessagesTool(),
	drag: new DragTool(),
	evaluate: new EvaluateTool(),
	fileUpload: new FileUploadTool(),
	handleDialog: new HandleDialogTool(),
	navigateBack: new NavigateBackTool(),
	networkRequests: new NetworkRequestsTool(),
	pressKey: new PressKeyTool(),
	snapshot: new SnapshotTool(),
	tabs: new TabsTool(),
	find: new FindTool(),
	interact: new InteractTool(),
	scrapeMenu: new ScrapeMenuTool(),
	scrapePage: new ScrapePageTool(),
};

// ---------------------------------------------------------------------------
// Helper to invoke a tool and show results in the output panel
// ---------------------------------------------------------------------------

// Map explorer tool names to command names used by the script generator
const TOOL_TO_COMMAND: Record<string, string> = {
	explorer_navigate: 'navigate',
	explorer_resize: 'resize',
	explorer_extract: 'extract',
	explorer_click: 'click',
	explorer_hover: 'hover',
	explorer_type: 'typeText',
	explorer_type_from_file: 'typeText',
	explorer_wait_for: 'waitFor',
	explorer_wait_for_element: 'waitForElement',
	explorer_select_option: 'selectOption',
	explorer_fill_form: 'fillForm',
	explorer_take_screenshot: 'screenshot',
	explorer_close: 'close',
	explorer_console_messages: 'consoleMessages',
	explorer_drag: 'drag',
	explorer_evaluate: 'evaluate',
	explorer_file_upload: 'fileUpload',
	explorer_handle_dialog: 'handleDialog',
	explorer_navigate_back: 'navigateBack',
	explorer_network_requests: 'networkRequests',
	explorer_press_key: 'pressKey',
	explorer_snapshot: 'snapshot',
	explorer_tabs: 'tabs',
	explorer_install: 'install',
	explorer_find: 'find',
	explorer_interact: 'interact',
	explorer_scrape_menu: 'scrapeMenu',
	explorer_scrape_page: 'scrapePage',
};

async function invokeToolForTest<T>(
	toolName: string,
	tool: vscode.LanguageModelTool<T>,
	input: T,
): Promise<void> {
	outputChannel.show(true);
	outputChannel.appendLine(`\n${'='.repeat(60)}`);
	outputChannel.appendLine(`🔧 Testing: ${toolName}`);
	outputChannel.appendLine(`📥 Input: ${JSON.stringify(input, null, 2)}`);
	outputChannel.appendLine(`${'─'.repeat(60)}`);

	try {
		const result = await tool.invoke(
			{ input, toolInvocationToken: undefined as any },
			new vscode.CancellationTokenSource().token,
		);
		let output = '';
		if (result?.content) {
			for (const part of result.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					output += part.value;
				}
			}
		}

		// Record the action if recording is active
		if (isRecording()) {
			const command = TOOL_TO_COMMAND[toolName] || toolName;
			recordAction(command, input as Record<string, unknown>, 'user');
		}

		outputChannel.appendLine(`📤 Result:`);
		outputChannel.appendLine(output || '(no output)');
		outputChannel.appendLine(`${'='.repeat(60)}\n`);
		vscode.window.showInformationMessage(`${toolName} completed - see Output panel`);
	} catch (error: any) {
		outputChannel.appendLine(`❌ Error: ${error.message}`);
		outputChannel.appendLine(`${'='.repeat(60)}\n`);
		vscode.window.showErrorMessage(`${toolName} failed: ${error.message}`);
	}
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('WebCure Tools');
	const registrations: vscode.Disposable[] = [];

	// Persist recorded actions to workspaceState so they survive extension-host restarts
	initRecorder((isActive, actions) => {
		context.workspaceState.update('webcure.recordedActions', actions);
		context.workspaceState.update('webcure.isRecording', isActive);
	});

	// ============================================
	// 1. LANGUAGE MODEL TOOLS (VS Code Copilot)
	// ============================================

	registrations.push(vscode.lm.registerTool('explorer_navigate', new NavigateTool()));
	registrations.push(vscode.lm.registerTool('explorer_resize', new ResizeTool()));
	registrations.push(vscode.lm.registerTool('explorer_extract', new ExtractTool()));
	registrations.push(vscode.lm.registerTool('explorer_click', new ClickTool()));
	registrations.push(vscode.lm.registerTool('explorer_hover', new HoverTool()));
	registrations.push(vscode.lm.registerTool('explorer_type', new TypeTool()));
	registrations.push(vscode.lm.registerTool('explorer_type_from_file', new TypeFromFileTool()));
	registrations.push(vscode.lm.registerTool('explorer_wait_for', new WaitForTool()));
	registrations.push(vscode.lm.registerTool('explorer_wait_for_element', new WaitForElementTool()));
	registrations.push(vscode.lm.registerTool('explorer_select_option', new SelectTool()));
	registrations.push(vscode.lm.registerTool('explorer_fill_form', new FillFormTool()));
	registrations.push(vscode.lm.registerTool('explorer_take_screenshot', new ScreenshotTool()));
	registrations.push(vscode.lm.registerTool('explorer_close', new CloseTool()));
	registrations.push(vscode.lm.registerTool('explorer_console_messages', new ConsoleMessagesTool()));
	registrations.push(vscode.lm.registerTool('explorer_drag', new DragTool()));
	registrations.push(vscode.lm.registerTool('explorer_evaluate', new EvaluateTool()));
	registrations.push(vscode.lm.registerTool('explorer_file_upload', new FileUploadTool()));
	registrations.push(vscode.lm.registerTool('explorer_handle_dialog', new HandleDialogTool()));
	registrations.push(vscode.lm.registerTool('explorer_navigate_back', new NavigateBackTool()));
	registrations.push(vscode.lm.registerTool('explorer_network_requests', new NetworkRequestsTool()));
	registrations.push(vscode.lm.registerTool('explorer_press_key', new PressKeyTool()));
	registrations.push(vscode.lm.registerTool('explorer_snapshot', new SnapshotTool()));
	registrations.push(vscode.lm.registerTool('explorer_tabs', new TabsTool()));
	registrations.push(vscode.lm.registerTool('explorer_install', new InstallBrowserTool()));
	registrations.push(vscode.lm.registerTool('explorer_find', new FindTool()));
	registrations.push(vscode.lm.registerTool('explorer_interact', new InteractTool()));
	registrations.push(vscode.lm.registerTool('explorer_scrape_menu', new ScrapeMenuTool()));
	registrations.push(vscode.lm.registerTool('explorer_scrape_page', new ScrapePageTool()));

	// ============================================
	// 2. FILE BRIDGE (Cursor / AI agent integration)
	// ============================================

	const bridgeConfig = vscode.workspace.getConfiguration('webcure');
	if (bridgeConfig.get<boolean>('bridge.enabled', true)) {
		setBridgeToolInstances(toolInstances);
		startBridge(context);
		registrations.push({ dispose: () => stopBridge() });
	}

	// ============================================
	// 3. API SERVER
	// ============================================

	const apiServer = new ApiServer(toolInstances, outputChannel);

	const config = vscode.workspace.getConfiguration('webcure');
	if (config.get<boolean>('api.enabled', false)) {
		const port = config.get<number>('api.port', 5678);
		const host = config.get<string>('api.host', '127.0.0.1');
		apiServer.start(port, host).then(actualPort => {
			if (actualPort !== port) {
				vscode.window.showInformationMessage(`WebCure API Server: port ${port} was busy, started on port ${actualPort} instead.`);
			}
		}).catch(() => {});
	}

	registrations.push(vscode.commands.registerCommand('webcure.startApiServer', async () => {
		const cfg = vscode.workspace.getConfiguration('webcure');
		const port = cfg.get<number>('api.port', 5678);
		const host = cfg.get<string>('api.host', '127.0.0.1');
		try {
			const actualPort = await apiServer.start(port, host);
			if (actualPort !== port) {
				vscode.window.showInformationMessage(`WebCure API Server: port ${port} was busy, started on ${host}:${actualPort}`);
			} else {
				vscode.window.showInformationMessage(`WebCure API Server started on ${host}:${actualPort}`);
			}
		} catch (err: any) {
			vscode.window.showErrorMessage(`WebCure API Server failed to start: ${err.message}`);
		}
	}));

	registrations.push(vscode.commands.registerCommand('webcure.stopApiServer', () => {
		apiServer.stop();
		vscode.window.showInformationMessage('WebCure API Server stopped');
	}));

	// Listen for configuration changes
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('webcure.api.enabled') ||
			e.affectsConfiguration('webcure.api.port') ||
			e.affectsConfiguration('webcure.api.host')) {
			const newConfig = vscode.workspace.getConfiguration('webcure');
			const enabled = newConfig.get<boolean>('api.enabled', false);
			const port = newConfig.get<number>('api.port', 5678);
			const host = newConfig.get<string>('api.host', '127.0.0.1');
			apiServer.stop();
			if (enabled) {
				apiServer.start(port, host);
			}
		}
	}));

	// ============================================
	// 4. RECORDING COMMANDS
	// ============================================

	registrations.push(vscode.commands.registerCommand('webcure.startRecording', () => {
		startRecording();
		outputChannel.show(false);
		const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
		outputChannel.appendLine(`\n${'='.repeat(60)}`);
		outputChannel.appendLine(`[${ts}] [INFO] WebCure: Script recording started. Use browser commands, then run "Stop Recording".`);
		outputChannel.appendLine(`${'='.repeat(60)}\n`);
	}));

	registrations.push(vscode.commands.registerCommand('webcure.stopRecording', async () => {
		let actions = stopRecording();

		// Fall back to persisted actions if in-memory log is empty
		// (handles extension-host restart after browser close, etc.)
		if (actions.length === 0) {
			actions = context.workspaceState.get<any[]>('webcure.recordedActions', []);
		}
		// Clear persisted state
		context.workspaceState.update('webcure.recordedActions', undefined);
		context.workspaceState.update('webcure.isRecording', undefined);

		outputChannel.show(false);
		const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
		outputChannel.appendLine(`\n${'='.repeat(60)}`);
		outputChannel.appendLine(`[${ts}] [INFO] WebCure: Script recording stopped — ${actions.length} action(s) captured.`);
		outputChannel.appendLine(`${'='.repeat(60)}\n`);

		if (actions.length === 0) {
			vscode.window.showWarningMessage('WebCure: No actions recorded');
			return;
		}
		const script = generatePythonScript(actions);

		// Auto-start the API server if not already running so the script can execute
		if (!apiServer.actualPort) {
			const cfg = vscode.workspace.getConfiguration('webcure');
			const port = cfg.get<number>('api.port', 5678);
			const host = cfg.get<string>('api.host', '127.0.0.1');
			try {
				const actualPort = await apiServer.start(port, host);
				vscode.window.showInformationMessage(`WebCure: API Server auto-started on ${host}:${actualPort}`);
			} catch {
				// Non-fatal — user can start manually
			}
		}

		// Open a new untitled document with the generated Python script
		const doc = await vscode.workspace.openTextDocument({
			language: 'python',
			content: script,
		});
		await vscode.window.showTextDocument(doc);
		vscode.window.showInformationMessage(`WebCure: Generated Python script with ${actions.length} actions`);
	}));

	// ============================================
	// 5. SCRIPT RUNNER
	// ============================================

	const isFailureOutput = (output: string): boolean => {
		const failurePatterns = [
			/\bError:/i, /\bFailed:/i, /\bFailed to/i, /\bCould not/i,
			/\bUnable to/i, /\bnot found\b/i, /\bno .* found\b/i,
			/\bInvalid/i, /\bTimeout/i, /\bTimed out/i,
			/\bNo page available/i, /\bProvide ref, text, or selector/i,
			/\bUse explorer_find or explorer_snapshot first/i,
		];
		return failurePatterns.some(p => p.test(output));
	};

	const executeStepWithRetry = async (
		tool: vscode.LanguageModelTool<any>,
		params: any,
		retries: number,
		retryDelay: number,
		out: vscode.OutputChannel,
	): Promise<{ success: boolean; output: string; attempts: number }> => {
		let lastOutput = '';
		for (let attempt = 1; attempt <= retries + 1; attempt++) {
			try {
				const result = await tool.invoke(
					{ input: params, toolInvocationToken: undefined as any },
					new vscode.CancellationTokenSource().token,
				);
				let output = '';
				if (result?.content) {
					for (const part of result.content) {
						if (part instanceof vscode.LanguageModelTextPart) {
							output += part.value;
						}
					}
				}
				lastOutput = output;
				if (isFailureOutput(output)) {
					if (attempt <= retries) {
						out.appendLine(`   ⚠️ Attempt ${attempt} detected failure, retrying in ${retryDelay}ms...`);
						await new Promise(r => setTimeout(r, retryDelay));
						continue;
					}
					return { success: false, output, attempts: attempt };
				}
				return { success: true, output, attempts: attempt };
			} catch (error: any) {
				lastOutput = error.message;
				if (attempt <= retries) {
					out.appendLine(`   ⚠️ Attempt ${attempt}: ${error.message}, retrying in ${retryDelay}ms...`);
					await new Promise(r => setTimeout(r, retryDelay));
					continue;
				}
				return { success: false, output: `Exception: ${error.message}`, attempts: attempt };
			}
		}
		return { success: false, output: lastOutput, attempts: retries + 1 };
	};

	registrations.push(vscode.commands.registerCommand('webcure.runScript', async () => {
		const filePath = await vscode.window.showInputBox({
			prompt: 'Path to JSON script file',
			placeHolder: '/path/to/script.json',
		});
		if (!filePath) return;

		const fileUri = vscode.Uri.file(filePath.trim());
		try {
			const fileContent = await vscode.workspace.fs.readFile(fileUri);
			const script = JSON.parse(Buffer.from(fileContent).toString('utf8'));
			const scriptRetries = script.retries ?? 0;
			const scriptRetryDelay = script.retryDelay ?? 1000;

			outputChannel.show(true);
			outputChannel.appendLine(`\n${'═'.repeat(70)}`);
			outputChannel.appendLine(`🚀 RUNNING SCRIPT: ${script.name || 'Unnamed Script'}`);
			outputChannel.appendLine(`📁 File: ${fileUri.fsPath}`);
			outputChannel.appendLine(`📋 Steps: ${script.steps?.length || 0}`);
			outputChannel.appendLine(`${'═'.repeat(70)}\n`);

			if (!script.steps || !Array.isArray(script.steps)) {
				outputChannel.appendLine('❌ Error: Script must have a "steps" array');
				return;
			}

			const variables: Map<string, string> = new Map(Object.entries(script.variables || {}));

			const substituteVariables = (obj: any): any => {
				if (typeof obj === 'string') {
					return obj.replace(/\$\{(\w+)\}/g, (match: string, varName: string) => {
						return variables.get(varName) ?? match;
					});
				}
				if (Array.isArray(obj)) return obj.map(item => substituteVariables(item));
				if (typeof obj === 'object' && obj !== null) {
					const result: Record<string, any> = {};
					for (const [key, value] of Object.entries(obj)) {
						result[key] = substituteVariables(value);
					}
					return result;
				}
				return obj;
			};

			const extractRefFromOutput = (output: string): string | null => {
				const m = output.match(/\[ref=(e\d+)\]/);
				return m ? m[1] : null;
			};

			const toolMap: Record<string, vscode.LanguageModelTool<any>> = {
				navigate: toolInstances.navigate,
				resize: toolInstances.resize,
				extract: toolInstances.extract,
				click: toolInstances.click,
				hover: toolInstances.hover,
				type: toolInstances.type,
				typeFromFile: toolInstances.typeFromFile,
				type_from_file: toolInstances.typeFromFile,
				waitFor: toolInstances.waitFor,
				wait_for: toolInstances.waitFor,
				waitForElement: toolInstances.waitForElement,
				wait_for_element: toolInstances.waitForElement,
				select: toolInstances.select,
				selectOption: toolInstances.select,
				select_option: toolInstances.select,
				fillForm: toolInstances.fillForm,
				fill_form: toolInstances.fillForm,
				screenshot: toolInstances.screenshot,
				takeScreenshot: toolInstances.screenshot,
				take_screenshot: toolInstances.screenshot,
				close: toolInstances.close,
				consoleMessages: toolInstances.consoleMessages,
				console_messages: toolInstances.consoleMessages,
				drag: toolInstances.drag,
				evaluate: toolInstances.evaluate,
				fileUpload: toolInstances.fileUpload,
				file_upload: toolInstances.fileUpload,
				handleDialog: toolInstances.handleDialog,
				handle_dialog: toolInstances.handleDialog,
				navigateBack: toolInstances.navigateBack,
				navigate_back: toolInstances.navigateBack,
				networkRequests: toolInstances.networkRequests,
				network_requests: toolInstances.networkRequests,
				pressKey: toolInstances.pressKey,
				press_key: toolInstances.pressKey,
				snapshot: toolInstances.snapshot,
				tabs: toolInstances.tabs,
				find: toolInstances.find,
				interact: toolInstances.interact,
				scrapeMenu: toolInstances.scrapeMenu,
				scrape_menu: toolInstances.scrapeMenu,
				scrapePage: toolInstances.scrapePage,
				scrape_page: toolInstances.scrapePage,
			};

			let stepNumber = 0;
			let successCount = 0;
			let failCount = 0;
			let totalRetries = 0;

			for (const step of script.steps) {
				stepNumber++;
				const toolName = step.tool;
				const rawParams = step.params || {};
				const params = substituteVariables(rawParams);
				const stepRetries = step.retries ?? scriptRetries;
				const stepRetryDelay = step.retryDelay ?? scriptRetryDelay;

				outputChannel.appendLine(`${'─'.repeat(60)}`);
				outputChannel.appendLine(`📍 Step ${stepNumber}/${script.steps.length}: ${toolName}`);
				if (step.description) outputChannel.appendLine(`   ${step.description}`);
				outputChannel.appendLine(`📥 Params: ${JSON.stringify(params)}`);

				const tool = toolMap[toolName];
				if (!tool) {
					outputChannel.appendLine(`❌ Unknown tool: ${toolName}`);
					failCount++;
					if (step.stopOnError !== false && script.stopOnError !== false) {
						outputChannel.appendLine(`\n⛔ Script stopped due to error`);
						break;
					}
					continue;
				}

				const execResult = await executeStepWithRetry(tool, params, stepRetries, stepRetryDelay, outputChannel);
				if (execResult.attempts > 1) totalRetries += execResult.attempts - 1;

				const output = execResult.output;
				if (step.captureRef && execResult.success) {
					const ref = extractRefFromOutput(output);
					if (ref) {
						variables.set(step.captureRef, ref);
						outputChannel.appendLine(`📌 Captured ref: ${step.captureRef} = "${ref}"`);
					}
				}
				if (step.captureValue && step.capturePattern && execResult.success) {
					try {
						const match = output.match(new RegExp(step.capturePattern));
						if (match?.[1]) {
							variables.set(step.captureValue, match[1]);
							outputChannel.appendLine(`📌 Captured value: ${step.captureValue} = "${match[1]}"`);
						}
					} catch { /* ignore bad pattern */ }
				}

				const maxLen = 2000;
				outputChannel.appendLine(`📤 Result:`);
				outputChannel.appendLine(output.length > maxLen ? output.substring(0, maxLen) + '\n... [truncated]' : output || '(no output)');

				if (execResult.success) {
					outputChannel.appendLine(`✅ Step ${stepNumber} completed`);
					successCount++;
				} else {
					outputChannel.appendLine(`❌ Step ${stepNumber} FAILED`);
					failCount++;
					if (step.stopOnError !== false && script.stopOnError !== false) {
						outputChannel.appendLine(`\n⛔ Script stopped due to error`);
						break;
					}
				}
			}

			outputChannel.appendLine(`\n${'═'.repeat(70)}`);
			outputChannel.appendLine(`📊 SCRIPT COMPLETED: ✅ ${successCount} passed, ❌ ${failCount} failed out of ${stepNumber} steps`);
			if (totalRetries > 0) outputChannel.appendLine(`   🔄 Total retries: ${totalRetries}`);
			outputChannel.appendLine(`${'═'.repeat(70)}\n`);

			if (failCount === 0) {
				vscode.window.showInformationMessage(`Script completed: ${successCount} steps successful`);
			} else {
				vscode.window.showWarningMessage(`Script completed: ${successCount} passed, ${failCount} failed`);
			}
		} catch (error: any) {
			outputChannel.appendLine(`❌ Failed to run script: ${error.message}`);
			vscode.window.showErrorMessage(`Failed to run script: ${error.message}`);
		}
	}));

	// ============================================
	// 6. TEST COMMANDS (Command Palette)
	// ============================================

	// Navigate
	registrations.push(vscode.commands.registerCommand('webcure.testNavigate', async () => {
		const url = await vscode.window.showInputBox({ prompt: 'URL to navigate to', value: 'https://demo.testfire.net' });
		if (url) await invokeToolForTest('explorer_navigate', toolInstances.navigate, { url });
	}));

	// Resize
	registrations.push(vscode.commands.registerCommand('webcure.testResize', async () => {
		const preset = await vscode.window.showQuickPick([
			{ label: 'Fullscreen', value: 'fullscreen' },
			{ label: 'Custom Size', value: 'custom' },
		]);
		if (preset?.value === 'fullscreen') {
			await invokeToolForTest('explorer_resize', toolInstances.resize, { preset: 'fullscreen' });
		} else if (preset?.value === 'custom') {
			const w = await vscode.window.showInputBox({ prompt: 'Width', value: '1920' });
			const h = await vscode.window.showInputBox({ prompt: 'Height', value: '1080' });
			if (w && h) await invokeToolForTest('explorer_resize', toolInstances.resize, { width: parseInt(w), height: parseInt(h) });
		}
	}));

	// Extract
	registrations.push(vscode.commands.registerCommand('webcure.testExtract', async () => {
		const selector = await vscode.window.showInputBox({ prompt: 'CSS selector (leave empty for full page)' });
		await invokeToolForTest('explorer_extract', toolInstances.extract, { selector: selector || undefined, maxLength: 8000, trimWhitespace: true });
	}));

	// Click
	registrations.push(vscode.commands.registerCommand('webcure.testClick', async () => {
		const params = await gatherElementTargetParams('Click');
		if (params) await invokeToolForTest('explorer_click', toolInstances.click, params);
	}));

	// Hover
	registrations.push(vscode.commands.registerCommand('webcure.testHover', async () => {
		const params = await gatherElementTargetParams('Hover');
		if (params) await invokeToolForTest('explorer_hover', toolInstances.hover, params);
	}));

	// Type
	registrations.push(vscode.commands.registerCommand('webcure.testType', async () => {
		const params = await gatherElementTargetParams('Type');
		if (!params) return;
		const value = await vscode.window.showInputBox({ prompt: 'Text to type' });
		if (!value) return;
		params.value = value;
		await invokeToolForTest('explorer_type', toolInstances.type, params);
	}));

	// Type from file
	registrations.push(vscode.commands.registerCommand('webcure.testTypeFromFile', async () => {
		const params = await gatherElementTargetParams('TypeFromFile');
		if (!params) return;
		const filePath = await vscode.window.showInputBox({ prompt: 'File path containing text to type' });
		if (!filePath) return;
		params.filePath = filePath;
		await invokeToolForTest('explorer_type_from_file', toolInstances.typeFromFile, params);
	}));

	// Wait For
	registrations.push(vscode.commands.registerCommand('webcure.testWaitFor', async () => {
		const waitType = await vscode.window.showQuickPick([
			{ label: 'Wait for text to appear', value: 'appear' },
			{ label: 'Wait for text to disappear', value: 'disappear' },
			{ label: 'Wait fixed time', value: 'time' },
		]);
		if (waitType?.value === 'appear') {
			const text = await vscode.window.showInputBox({ prompt: 'Text to wait for' });
			if (text) await invokeToolForTest('explorer_wait_for', toolInstances.waitFor, { text });
		} else if (waitType?.value === 'disappear') {
			const textGone = await vscode.window.showInputBox({ prompt: 'Text to wait to disappear' });
			if (textGone) await invokeToolForTest('explorer_wait_for', toolInstances.waitFor, { textGone });
		} else if (waitType?.value === 'time') {
			const time = await vscode.window.showInputBox({ prompt: 'Seconds to wait', value: '2' });
			if (time) await invokeToolForTest('explorer_wait_for', toolInstances.waitFor, { time: parseInt(time) });
		}
	}));

	// Wait For Element
	registrations.push(vscode.commands.registerCommand('webcure.testWaitForElement', async () => {
		const params = await gatherElementTargetParams('WaitForElement');
		if (!params) return;
		const state = await vscode.window.showQuickPick([
			{ label: 'visible', value: 'visible' },
			{ label: 'hidden', value: 'hidden' },
			{ label: 'attached', value: 'attached' },
			{ label: 'detached', value: 'detached' },
		], { placeHolder: 'State to wait for' });
		if (!state) return;
		params.state = state.value;
		await invokeToolForTest('explorer_wait_for_element', toolInstances.waitForElement, params);
	}));

	// Select Option
	registrations.push(vscode.commands.registerCommand('webcure.testSelectOption', async () => {
		const params = await gatherElementTargetParams('SelectOption');
		if (!params) return;
		const values = await vscode.window.showInputBox({ prompt: 'Values to select (comma-separated)' });
		if (!values) return;
		params.values = values.split(',').map((v: string) => v.trim());
		await invokeToolForTest('explorer_select_option', toolInstances.select, params);
	}));

	// Fill Form
	registrations.push(vscode.commands.registerCommand('webcure.testFillForm', async () => {
		const jsonInput = await vscode.window.showInputBox({
			prompt: 'Fields JSON',
			value: '[{"name":"username","ref":"e5","type":"textbox","value":"testuser"}]',
		});
		if (jsonInput) {
			try {
				await invokeToolForTest('explorer_fill_form', toolInstances.fillForm, { fields: JSON.parse(jsonInput) });
			} catch (e) {
				vscode.window.showErrorMessage(`Invalid JSON: ${e}`);
			}
		}
	}));

	// Screenshot
	registrations.push(vscode.commands.registerCommand('webcure.testScreenshot', async () => {
		const scope = await vscode.window.showQuickPick([
			{ label: 'Viewport only', value: 'viewport' },
			{ label: 'Full page', value: 'fullpage' },
			{ label: 'Element (from Snapshot)', value: 'element' },
		]);
		const params: any = { type: 'png' };
		if (scope?.value === 'fullpage') params.fullPage = true;
		else if (scope?.value === 'element') {
			const ref = await vscode.window.showInputBox({ prompt: 'Element ref', placeHolder: 'e12' });
			if (!ref) return;
			params.ref = ref;
		}
		await invokeToolForTest('explorer_take_screenshot', toolInstances.screenshot, params);
	}));

	// Close
	registrations.push(vscode.commands.registerCommand('webcure.testClose', async () => {
		await invokeToolForTest('explorer_close', toolInstances.close, {});
	}));

	// Console Messages
	registrations.push(vscode.commands.registerCommand('webcure.testConsoleMessages', async () => {
		const onlyErrors = await vscode.window.showQuickPick([
			{ label: 'All messages', value: false },
			{ label: 'Errors only', value: true },
		]);
		await invokeToolForTest('explorer_console_messages', toolInstances.consoleMessages, { onlyErrors: onlyErrors?.value ?? false });
	}));

	// Drag
	registrations.push(vscode.commands.registerCommand('webcure.testDrag', async () => {
		const startRef = await vscode.window.showInputBox({ prompt: 'START element ref', placeHolder: 'e3' });
		if (!startRef) return;
		const endRef = await vscode.window.showInputBox({ prompt: 'END element ref', placeHolder: 'e5' });
		if (!endRef) return;
		await invokeToolForTest('explorer_drag', toolInstances.drag, { startRef, startElement: 'start', endRef, endElement: 'end' });
	}));

	// Evaluate
	registrations.push(vscode.commands.registerCommand('webcure.testEvaluate', async () => {
		const fn = await vscode.window.showInputBox({ prompt: 'JavaScript expression', value: '() => document.title' });
		if (fn) await invokeToolForTest('explorer_evaluate', toolInstances.evaluate, { function: fn });
	}));

	// File Upload
	registrations.push(vscode.commands.registerCommand('webcure.testFileUpload', async () => {
		const pathsInput = await vscode.window.showInputBox({ prompt: 'File path(s) comma-separated' });
		if (!pathsInput) return;
		const paths = pathsInput.split(',').map(p => p.trim()).filter(p => p.length > 0);
		const selector = await vscode.window.showInputBox({ prompt: 'File input selector', value: 'input[type="file"]' });
		await invokeToolForTest('explorer_file_upload', toolInstances.fileUpload, { paths, selector: selector || undefined });
	}));

	// Handle Dialog
	registrations.push(vscode.commands.registerCommand('webcure.testHandleDialog', async () => {
		const accept = await vscode.window.showQuickPick([{ label: 'Accept', value: true }, { label: 'Dismiss', value: false }]);
		if (accept) await invokeToolForTest('explorer_handle_dialog', toolInstances.handleDialog, { accept: accept.value });
	}));

	// Navigate Back
	registrations.push(vscode.commands.registerCommand('webcure.testNavigateBack', async () => {
		await invokeToolForTest('explorer_navigate_back', toolInstances.navigateBack, {});
	}));

	// Network Requests
	registrations.push(vscode.commands.registerCommand('webcure.testNetworkRequests', async () => {
		await invokeToolForTest('explorer_network_requests', toolInstances.networkRequests, {});
	}));

	// Press Key
	registrations.push(vscode.commands.registerCommand('webcure.testPressKey', async () => {
		const key = await vscode.window.showInputBox({ prompt: 'Key to press', value: 'Enter' });
		if (key) await invokeToolForTest('explorer_press_key', toolInstances.pressKey, { key });
	}));

	// Snapshot
	registrations.push(vscode.commands.registerCommand('webcure.testSnapshot', async () => {
		await invokeToolForTest('explorer_snapshot', toolInstances.snapshot, {});
	}));

	// Tabs
	registrations.push(vscode.commands.registerCommand('webcure.testTabs', async () => {
		const action = await vscode.window.showQuickPick([
			{ label: 'List tabs', value: 'list' },
			{ label: 'New tab', value: 'new' },
			{ label: 'Close tab', value: 'close' },
			{ label: 'Select tab', value: 'select' },
		]);
		if (action?.value === 'list' || action?.value === 'new') {
			await invokeToolForTest('explorer_tabs', toolInstances.tabs, { action: action.value });
		} else if (action?.value === 'close' || action?.value === 'select') {
			const index = await vscode.window.showInputBox({ prompt: 'Tab index (1-based)', value: '1' });
			if (index) await invokeToolForTest('explorer_tabs', toolInstances.tabs, { action: action.value, index: parseInt(index) });
		}
	}));

	// Find
	registrations.push(vscode.commands.registerCommand('webcure.testFind', async () => {
		const findBy = await vscode.window.showQuickPick([
			{ label: 'By visible text', value: 'text' },
			{ label: 'By selector', value: 'selector' },
		]);
		if (!findBy) return;
		const findParams: any = {};
		if (findBy.value === 'text') {
			const text = await vscode.window.showInputBox({ prompt: 'Visible text to find' });
			if (!text) return;
			findParams.text = text;
		} else {
			const selector = await vscode.window.showInputBox({ prompt: 'CSS selector' });
			if (!selector) return;
			findParams.selector = selector;
		}
		await invokeToolForTest('explorer_find', toolInstances.find, findParams);
	}));

	// Interact
	registrations.push(vscode.commands.registerCommand('webcure.testInteract', async () => {
		const params = await gatherElementTargetParams('Interact');
		if (!params) return;
		const action = await vscode.window.showQuickPick([
			{ label: 'click' }, { label: 'type' }, { label: 'hover' },
			{ label: 'clear' }, { label: 'select' }, { label: 'focus' },
			{ label: 'check' }, { label: 'uncheck' }, { label: 'press' },
		]);
		if (!action) return;
		params.action = action.label;
		if (action.label === 'type' || action.label === 'select' || action.label === 'press') {
			const value = await vscode.window.showInputBox({ prompt: `Value for ${action.label}` });
			if (value) params.value = value;
		}
		await invokeToolForTest('explorer_interact', toolInstances.interact, params);
	}));

	// Scrape Menu
	registrations.push(vscode.commands.registerCommand('webcure.testScrapeMenu', async () => {
		await invokeToolForTest('explorer_scrape_menu', toolInstances.scrapeMenu, {});
	}));

	// Scrape Page
	registrations.push(vscode.commands.registerCommand('webcure.testScrapePage', async () => {
		await invokeToolForTest('explorer_scrape_page', toolInstances.scrapePage, { includeFormFields: true, includeTables: true, includeFilters: true, maxTableRows: 10 });
	}));

	// Quick Test Menu
	registrations.push(vscode.commands.registerCommand('webcure.testMenu', async () => {
		const choice = await vscode.window.showQuickPick([
			{ label: '$(globe) Navigate to URL', command: 'webcure.testNavigate' },
			{ label: '$(screen-full) Resize Window', command: 'webcure.testResize' },
			{ label: '$(file-text) Extract Text', command: 'webcure.testExtract' },
			{ label: '$(play) Click Element', command: 'webcure.testClick' },
			{ label: '$(eye) Hover Element', command: 'webcure.testHover' },
			{ label: '$(edit) Type Text', command: 'webcure.testType' },
			{ label: '$(clock) Wait For Text', command: 'webcure.testWaitFor' },
			{ label: '$(watch) Wait For Element', command: 'webcure.testWaitForElement' },
			{ label: '$(list-selection) Select Option', command: 'webcure.testSelectOption' },
			{ label: '$(device-camera) Screenshot', command: 'webcure.testScreenshot' },
			{ label: '$(terminal) Console Messages', command: 'webcure.testConsoleMessages' },
			{ label: '$(code) Evaluate JavaScript', command: 'webcure.testEvaluate' },
			{ label: '$(cloud-upload) File Upload', command: 'webcure.testFileUpload' },
			{ label: '$(arrow-left) Navigate Back', command: 'webcure.testNavigateBack' },
			{ label: '$(globe) Network Requests', command: 'webcure.testNetworkRequests' },
			{ label: '$(keyboard) Press Key', command: 'webcure.testPressKey' },
			{ label: '$(eye) Snapshot', command: 'webcure.testSnapshot' },
			{ label: '$(multiple-windows) Manage Tabs', command: 'webcure.testTabs' },
			{ label: '$(search) Find Element', command: 'webcure.testFind' },
			{ label: '$(zap) Interact', command: 'webcure.testInteract' },
			{ label: '$(list-tree) Scrape Menu', command: 'webcure.testScrapeMenu' },
			{ label: '$(table) Scrape Page', command: 'webcure.testScrapePage' },
			{ label: '$(record) Start Recording', command: 'webcure.startRecording' },
			{ label: '$(primitive-square) Stop Recording', command: 'webcure.stopRecording' },
			{ label: '$(close) Close Browser', command: 'webcure.testClose' },
		]);
		if (choice) vscode.commands.executeCommand((choice as any).command);
	}));

	context.subscriptions.push(...registrations);
}

// ---------------------------------------------------------------------------
// Helper: gather element targeting params (ref, text, or selector)
// ---------------------------------------------------------------------------

async function gatherElementTargetParams(operation: string): Promise<any | null> {
	const method = await vscode.window.showQuickPick([
		{ label: '$(key) By Ref', value: 'ref' },
		{ label: '$(search) By Text', value: 'text' },
		{ label: '$(code) By Selector', value: 'selector' },
	], { placeHolder: `${operation}: How to find the element?` });
	if (!method) return null;

	const params: any = {};
	if (method.value === 'ref') {
		const ref = await vscode.window.showInputBox({ prompt: 'Element ref (e.g. e1)', placeHolder: 'e1' });
		if (!ref) return null;
		params.ref = ref;
	} else if (method.value === 'text') {
		const text = await vscode.window.showInputBox({ prompt: 'Visible text to find' });
		if (!text) return null;
		params.text = text;
	} else {
		const selector = await vscode.window.showInputBox({ prompt: 'CSS or XPath selector' });
		if (!selector) return null;
		params.selector = selector;
	}
	params.element = params.text || params.selector || params.ref || 'element';
	return params;
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export async function deactivate() {
	stopBridge();
	await BrowserManager.dispose();
}
