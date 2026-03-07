/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as vscode from 'vscode';
import { BrowserManager } from './browserManager';
import * as os from 'os';
import * as path from 'path';

function textPart(text: string) {
	return new (vscode as any).LanguageModelTextPart(text);
}

function result(parts: any[]) {
	return new (vscode as any).LanguageModelToolResult(parts);
}

/**
 * Parse and get a Playwright locator from a selector string
 * Supports: CSS selectors, xpath=..., link=..., text=...
 */
function getLocator(page: any, selector: string) {
	// Handle link= prefix (search for links by text)
	if (selector.startsWith('link=')) {
		const linkText = selector.substring(5);
		return page.getByRole('link', { name: linkText });
	}
	
	// Handle text= prefix (search by text content)
	if (selector.startsWith('text=')) {
		const text = selector.substring(5);
		return page.getByText(text, { exact: false });
	}
	
	// Handle xpath= prefix or XPath starting with //
	if (selector.startsWith('xpath=')) {
		return page.locator(`xpath=${selector.substring(6)}`);
	}
	if (selector.startsWith('//') || selector.startsWith('(//')) {
		return page.locator(`xpath=${selector}`);
	}
	
	// Default: treat as CSS selector
	return page.locator(selector);
}

async function locatorByText(page: any, text: string) {
	return page.getByText(text, { exact: false });
}

/**
 * Unified element targeting - supports ref, text, selector, and positional options
 * Used by multiple tools for consistent element finding
 */
interface UnifiedTargetParams {
	ref?: string;
	text?: string;
	selector?: string;
	toLeftOf?: string;
	toRightOf?: string;
	above?: string;
	below?: string;
}

async function findElementByUnifiedTarget(page: any, params: UnifiedTargetParams): Promise<{ element: any; error?: string }> {
	const { ref, text, selector, toLeftOf, toRightOf, above, below } = params;
	
	let elementHandle: any = null;
	
	// Strategy 1: Get by ref (from explorer_find or explorer_snapshot)
	if (ref) {
		elementHandle = BrowserManager.getElementByRef(ref);
		if (!elementHandle) {
			return { element: null, error: `Element with ref="${ref}" not found. Use explorer_find or explorer_snapshot first.` };
		}
		return { element: elementHandle };
	}
	
	// Strategy 2: Find by text or selector with optional positional filtering
	if (text || selector) {
		let locator: any;
		if (text) {
			locator = page.getByText(text, { exact: false });
		} else {
			locator = getLocator(page, selector!);
		}
		
		// Apply relative positioning if specified
		if (toLeftOf || toRightOf || above || below) {
			const referenceText = toLeftOf || toRightOf || above || below;
			const refLocator = page.getByText(referenceText!, { exact: false });
			const refElement = await refLocator.first().elementHandle();
			const refBox = await refElement?.boundingBox();
			
			if (!refBox) {
				return { element: null, error: `Reference element "${referenceText}" not found.` };
			}
			
			// Find all candidates and filter by position
			const count = await locator.count();
			for (let i = 0; i < count; i++) {
				const el = await locator.nth(i).elementHandle();
				const box = await el?.boundingBox();
				if (!box) continue;
				
				const elCenterX = box.x + box.width / 2;
				const elCenterY = box.y + box.height / 2;
				const refCenterX = refBox.x + refBox.width / 2;
				const refCenterY = refBox.y + refBox.height / 2;
				
				let matches = false;
				if (toLeftOf) matches = elCenterX < refBox.x && Math.abs(elCenterY - refCenterY) < 50;
				else if (toRightOf) matches = elCenterX > refBox.x + refBox.width && Math.abs(elCenterY - refCenterY) < 50;
				else if (above) matches = elCenterY < refBox.y && Math.abs(elCenterX - refCenterX) < 100;
				else if (below) matches = elCenterY > refBox.y + refBox.height && Math.abs(elCenterX - refCenterX) < 100;
				
				if (matches) {
					elementHandle = el;
					break;
				}
			}
		} else {
			elementHandle = await locator.first().elementHandle();
		}
	}
	
	if (!elementHandle) {
		return { element: null, error: 'Could not find matching element. Provide ref, text, or selector.' };
	}
	
	return { element: elementHandle };
}

export interface NavigateParams { url: string; waitUntil?: 'load'|'domcontentloaded'|'networkidle'; }
export class NavigateTool implements vscode.LanguageModelTool<NavigateParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<NavigateParams>) {
		return {
			invocationMessage: `Navigating to ${options.input.url}`,
			confirmationMessages: {
				title: 'Open webpage',
				message: new vscode.MarkdownString(`Navigate to: ${options.input.url}\n\nwaitUntil: ${options.input.waitUntil ?? 'load'}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<NavigateParams>) {
		const page = await BrowserManager.getPage();
		try {
			await page.goto(options.input.url, { waitUntil: options.input.waitUntil ?? 'load' });
			const title = await page.title();
			const url = page.url();
			return result([textPart(`Navigated to ${url}\nTitle: ${title}`)]);
		} catch (error: any) {
			// Check if this was a download
			if (error.message && error.message.includes('Download is starting')) {
				// Wait a bit for the download event to fire
				await new Promise(resolve => setTimeout(resolve, 1000));
				const downloadPath = BrowserManager.getLastDownloadPath();
				if (downloadPath) {
					return result([textPart(`Download started successfully.\nFile saved to: ${downloadPath}`)]);
				} else {
					return result([textPart(`Download initiated for: ${options.input.url}\nNote: File should be saved to your browser's default downloads folder.`)]);
				}
			}
			throw error;
		}
	}
}

export interface ResizeParams { preset?: 'fullscreen'; width?: number; height?: number; }
export class ResizeTool implements vscode.LanguageModelTool<ResizeParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ResizeParams>) {
		const { preset, width, height } = options.input;
		return {
			invocationMessage: 'Resizing browser viewport',
			confirmationMessages: {
				title: 'Resize browser',
				message: new vscode.MarkdownString(preset ? `Preset: ${preset}` : `Size: ${width} x ${height}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ResizeParams>) {
		const page = await BrowserManager.getPage();
		if (options.input.preset === 'fullscreen') {
			try {
				// Use CDP to maximize the browser window
				const cdpSession = await page.context().newCDPSession(page);
				
				// Get the window ID first
				const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
				
				// Maximize the window
				await cdpSession.send('Browser.setWindowBounds', {
					windowId,
					bounds: { windowState: 'maximized' }
				});
				
				// Wait a moment for the window to maximize
				await page.waitForTimeout(300);
				
				// Get the actual bounds after maximizing
				const { bounds } = await cdpSession.send('Browser.getWindowBounds', { windowId });
				
				// Calculate viewport size (window size minus browser chrome)
				const chromeHeight = 85;
				const viewportWidth = bounds.width || 1920;
				const viewportHeight = (bounds.height || 1080) - chromeHeight;
				
				// Set viewport size - this may unmaximize the window
				await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
				
				// Re-maximize the window after setting viewport
				await cdpSession.send('Browser.setWindowBounds', {
					windowId,
					bounds: { windowState: 'maximized' }
				});
				
				return result([textPart(`Viewport set to ${viewportWidth}x${viewportHeight} (maximized window)`)]);
			} catch (error: any) {
				// Fallback to a reasonable default if CDP fails
				await page.setViewportSize({ width: 1920, height: 1080 });
				return result([textPart(`Viewport set to 1920x1080 (fallback - CDP error: ${error.message})`)]);
			}
		}
		const width = options.input.width ?? 1366;
		const height = options.input.height ?? 768;
		await page.setViewportSize({ width, height });
		return result([textPart(`Viewport set to ${width}x${height}`)]);
	}
}

export interface ExtractParams { selector?: string; maxLength?: number; trimWhitespace?: boolean; }
export class ExtractTool implements vscode.LanguageModelTool<ExtractParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ExtractParams>) {
		return {
			invocationMessage: 'Extracting page text',
			confirmationMessages: { title: 'Extract content', message: new vscode.MarkdownString(options.input.selector ? `Selector: ${options.input.selector}` : 'Whole page') }
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ExtractParams>) {
		const page = await BrowserManager.getPage();
		let text: string;
		if (options.input.selector) {
			const loc = page.locator(options.input.selector);
			await loc.waitFor({ state: 'visible', timeout: 10000 });
			text = await loc.innerText();
		} else {
			text = await page.evaluate(() => (document.body?.innerText ?? ''));
		}
		if (options.input.trimWhitespace !== false) {
			text = text.replace(/\s+/g, ' ').trim();
		}
		const max = options.input.maxLength ?? 8000;
		if (text.length > max) {
			text = text.slice(0, max);
		}
		return result([textPart(text)]);
	}
}

export interface ClickParams {
	element?: string;        // Human-readable element description
	ref?: string;            // Element reference from explorer_find/snapshot
	text?: string;           // Find by visible text (alternative to ref)
	selector?: string;       // Find by CSS/XPath selector (alternative to ref)
	button?: 'left'|'right'|'middle';
	double?: boolean;
	// Relative positioning
	toLeftOf?: string;
	toRightOf?: string;
	above?: string;
	below?: string;
}
export class ClickTool implements vscode.LanguageModelTool<ClickParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ClickParams>) {
		const { ref, text, selector, element, toLeftOf, toRightOf, above, below } = options.input;
		let target = ref ? `ref=${ref}` : (text ? `text="${text}"` : (selector ? `selector="${selector}"` : element || 'element'));
		if (toLeftOf) target += ` to left of "${toLeftOf}"`;
		if (toRightOf) target += ` to right of "${toRightOf}"`;
		if (above) target += ` above "${above}"`;
		if (below) target += ` below "${below}"`;
		return {
			invocationMessage: `Click ${target}`,
			confirmationMessages: {
				title: 'Click element',
				message: new vscode.MarkdownString(`Click: ${target}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ClickParams>) {
		const page = await BrowserManager.getPage();
		const { element, ref, text, selector, button, double, toLeftOf, toRightOf, above, below } = options.input;
		
		const { element: elementHandle, error } = await findElementByUnifiedTarget(page, { ref, text, selector, toLeftOf, toRightOf, above, below });
		if (error || !elementHandle) {
			return result([textPart(error || 'Could not find element.')]);
		}
		
		const clickAction = double
			? elementHandle.dblclick({ button: button ?? 'left', timeout: 6000 })
			: elementHandle.click({ button: button ?? 'left', timeout: 6000 });

		// Race click against a manual timeout — Playwright's click blocks on dialogs
		const clickDone = clickAction.then(() => 'done' as const).catch(() => 'click-error' as const);
		const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 5000));
		const raceResult = await Promise.race([clickDone, timeout]);

		if (raceResult === 'timeout' || raceResult === 'click-error') {
			const dialogInfo = BrowserManager.getLastDialogInfo();
			if (dialogInfo?.handled) {
				return result([textPart(`Clicked ${element || text || selector || ref} (dialog: ${dialogInfo.type} "${dialogInfo.message}" — ${dialogInfo.response})`)]);
			}
			throw new Error('Click timed out after 5000ms');
		}
		return result([textPart(`Clicked ${element || text || selector || ref}`)]);
	}
}

export interface HoverParams {
	element?: string;        // Human-readable element description
	ref?: string;            // Element reference from explorer_find/snapshot
	text?: string;           // Find by visible text (alternative to ref)
	selector?: string;       // Find by CSS/XPath selector (alternative to ref)
	// Relative positioning
	toLeftOf?: string;
	toRightOf?: string;
	above?: string;
	below?: string;
}
export class HoverTool implements vscode.LanguageModelTool<HoverParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<HoverParams>) {
		const { ref, text, selector, element, toLeftOf, toRightOf, above, below } = options.input;
		let target = ref ? `ref=${ref}` : (text ? `text="${text}"` : (selector ? `selector="${selector}"` : element || 'element'));
		if (toLeftOf) target += ` to left of "${toLeftOf}"`;
		if (toRightOf) target += ` to right of "${toRightOf}"`;
		if (above) target += ` above "${above}"`;
		if (below) target += ` below "${below}"`;
		return {
			invocationMessage: `Hover ${target}`,
			confirmationMessages: {
				title: 'Hover element',
				message: new vscode.MarkdownString(`Hover: ${target}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<HoverParams>) {
		const page = await BrowserManager.getPage();
		const { element, ref, text, selector, toLeftOf, toRightOf, above, below } = options.input;
		
		const { element: elementHandle, error } = await findElementByUnifiedTarget(page, { ref, text, selector, toLeftOf, toRightOf, above, below });
		if (error || !elementHandle) {
			return result([textPart(error || 'Could not find element.')]);
		}
		
		await elementHandle.hover();
		return result([textPart(`Hovered ${element || text || selector || ref}`)]);
	}
}

export interface TypeParams {
	element?: string;        // Human-readable element description
	ref?: string;            // Element reference from explorer_find/snapshot
	text?: string;           // Find by visible text (alternative to ref) - NOTE: conflicts with typing text
	selector?: string;       // Find by CSS/XPath selector (alternative to ref)
	value: string;           // Text to type (renamed from 'text' to avoid conflict)
	submit?: boolean;
	slowly?: boolean;
	// Relative positioning
	toLeftOf?: string;
	toRightOf?: string;
	above?: string;
	below?: string;
}
export class TypeTool implements vscode.LanguageModelTool<TypeParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<TypeParams>) {
		const { ref, text, selector, element, value, toLeftOf, toRightOf, above, below } = options.input;
		let target = ref ? `ref=${ref}` : (text ? `text="${text}"` : (selector ? `selector="${selector}"` : element || 'input'));
		if (toLeftOf) target += ` to left of "${toLeftOf}"`;
		if (toRightOf) target += ` to right of "${toRightOf}"`;
		if (above) target += ` above "${above}"`;
		if (below) target += ` below "${below}"`;
		return {
			invocationMessage: `Type into ${target}`,
			confirmationMessages: {
				title: 'Type text',
				message: new vscode.MarkdownString(`Type into: ${target}\nText: ${value}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<TypeParams>) {
		const page = await BrowserManager.getPage();
		const { element, ref, text, selector, value, submit, slowly, toLeftOf, toRightOf, above, below } = options.input;
		
		const { element: elementHandle, error } = await findElementByUnifiedTarget(page, { ref, text, selector, toLeftOf, toRightOf, above, below });
		if (error || !elementHandle) {
			return result([textPart(error || 'Could not find element.')]);
		}
		
		// Clear and type text
		await elementHandle.fill('');
		if (slowly) {
			for (const ch of value) {
				await elementHandle.type(ch);
			}
		} else {
			await elementHandle.type(value);
		}
		if (submit) {
			await elementHandle.press('Enter');
		}
		return result([textPart(`Typed into ${element || text || selector || ref}`)]);
	}
}

export interface TypeFromFileParams {
	ref?: string;            // Element reference from explorer_find
	text?: string;           // Find by visible text (alternative to ref)
	selector?: string;       // Find by selector (alternative to ref)
	element?: string;        // Human-readable element description
	filePath: string;        // Path to file containing text to type
	submit?: boolean;        // Press Enter after typing
	// Relative positioning (like InteractTool)
	toLeftOf?: string;
	toRightOf?: string;
	above?: string;
	below?: string;
}
export class TypeFromFileTool implements vscode.LanguageModelTool<TypeFromFileParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<TypeFromFileParams>) {
		const { ref, text, selector, element, filePath, toLeftOf, toRightOf, above, below } = options.input;
		let target = ref ? `ref=${ref}` : (text ? `text="${text}"` : (selector ? `selector="${selector}"` : element || 'input'));
		if (toLeftOf) target += ` to left of "${toLeftOf}"`;
		if (toRightOf) target += ` to right of "${toRightOf}"`;
		if (above) target += ` above "${above}"`;
		if (below) target += ` below "${below}"`;
		
		return {
			invocationMessage: `Type file content into ${target}`,
			confirmationMessages: {
				title: 'Type text from file',
				message: new vscode.MarkdownString(`**Target:** ${target}\n**File:** ${filePath}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<TypeFromFileParams>) {
		const page = await BrowserManager.getPage();
		const { ref, text, selector, element, filePath, submit, toLeftOf, toRightOf, above, below } = options.input;
		
		let elementHandle: any = null;
		
		// Get element by ref, text, or selector
		if (ref) {
			elementHandle = BrowserManager.getElementByRef(ref);
			if (!elementHandle) {
				return result([textPart(`Element with ref="${ref}" not found. Use explorer_find first.`)]);
			}
		} else if (text || selector) {
			// Find element directly
			let locator: any;
			if (text) {
				locator = page.getByText(text, { exact: false });
			} else {
				locator = getLocator(page, selector!);
			}
			
			// Apply relative positioning if specified
			if (toLeftOf || toRightOf || above || below) {
				const referenceText = toLeftOf || toRightOf || above || below;
				const refLocator = page.getByText(referenceText!, { exact: false });
				const refElement = await refLocator.first().elementHandle();
				const refBox = await refElement?.boundingBox();
				
				if (!refBox) {
					return result([textPart(`Reference element "${referenceText}" not found.`)]);
				}
				
				// Find all candidates and filter by position
				const count = await locator.count();
				for (let i = 0; i < count; i++) {
					const el = await locator.nth(i).elementHandle();
					const box = await el?.boundingBox();
					if (!box) continue;
					
					const elCenterX = box.x + box.width / 2;
					const elCenterY = box.y + box.height / 2;
					const refCenterX = refBox.x + refBox.width / 2;
					const refCenterY = refBox.y + refBox.height / 2;
					
					let matches = false;
					if (toLeftOf) matches = elCenterX < refBox.x && Math.abs(elCenterY - refCenterY) < 50;
					else if (toRightOf) matches = elCenterX > refBox.x + refBox.width && Math.abs(elCenterY - refCenterY) < 50;
					else if (above) matches = elCenterY < refBox.y && Math.abs(elCenterX - refCenterX) < 100;
					else if (below) matches = elCenterY > refBox.y + refBox.height && Math.abs(elCenterX - refCenterX) < 100;
					
					if (matches) {
						elementHandle = el;
						break;
					}
				}
			} else {
				elementHandle = await locator.first().elementHandle();
			}
		} else {
			return result([textPart('Please provide ref, text, or selector to identify the element.')]);
		}
		
		if (!elementHandle) {
			return result([textPart('Could not find matching element.')]);
		}
		
		// Read file content
		const fileUri = vscode.Uri.file(filePath.trim());
		const fileContent = await vscode.workspace.fs.readFile(fileUri);
		const fileText = Buffer.from(fileContent).toString('utf8');
		
		if (fileText.length === 0) {
			return result([textPart(`File is empty: ${filePath}`)]);
		}
		
		// Use fill() to set the value directly (type() causes double line breaks due to newline handling)
		await elementHandle.fill(fileText);
		
		if (submit) {
			await elementHandle.press('Enter');
		}
		
		const target = element || text || selector || ref || 'input';
		return result([textPart(`Typed ${fileText.length} characters from file into ${target}`)]);
	}
}

export interface WaitForParams { time?: number; text?: string; textGone?: string; timeout?: number; }
export class WaitForTool implements vscode.LanguageModelTool<WaitForParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WaitForParams>) {
		return { invocationMessage: 'Waiting', confirmationMessages: { title: 'Wait', message: new vscode.MarkdownString(JSON.stringify(options.input)) } };
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<WaitForParams>) {
		const page = await BrowserManager.getPage();
		const timeout = options.input.timeout ?? 30000;
		if (options.input.time) {
			await page.waitForTimeout(options.input.time * 1000);
			return result([textPart(`Waited ${options.input.time}s`)]);
		}
		if (options.input.text) {
			await page.getByText(options.input.text, { exact: false }).waitFor({ state: 'visible', timeout });
			return result([textPart(`Text appeared: ${options.input.text}`)]);
		}
		if (options.input.textGone) {
			await page.getByText(options.input.textGone, { exact: false }).waitFor({ state: 'detached', timeout });
			return result([textPart(`Text disappeared: ${options.input.textGone}`)]);
		}
		return result([textPart('No-op')]);
	}
}

export interface SelectParams {
	element?: string;        // Human-readable element description
	ref?: string;            // Element reference from explorer_find/snapshot
	text?: string;           // Find by visible text (alternative to ref)
	selector?: string;       // Find by CSS/XPath selector (alternative to ref)
	values: string[];        // Values/labels to select
	// Relative positioning
	toLeftOf?: string;
	toRightOf?: string;
	above?: string;
	below?: string;
}
export class SelectTool implements vscode.LanguageModelTool<SelectParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SelectParams>) {
		const { ref, text, selector, element, values, toLeftOf, toRightOf, above, below } = options.input;
		let target = ref ? `ref=${ref}` : (text ? `text="${text}"` : (selector ? `selector="${selector}"` : element || 'select'));
		if (toLeftOf) target += ` to left of "${toLeftOf}"`;
		if (toRightOf) target += ` to right of "${toRightOf}"`;
		if (above) target += ` above "${above}"`;
		if (below) target += ` below "${below}"`;
		return {
			invocationMessage: `Select option in ${target}`,
			confirmationMessages: {
				title: 'Select option',
				message: new vscode.MarkdownString(`Select in: ${target}\nValues: ${values.join(', ')}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<SelectParams>) {
		const page = await BrowserManager.getPage();
		const { element, ref, text, selector, values, toLeftOf, toRightOf, above, below } = options.input;
		
		const { element: elementHandle, error } = await findElementByUnifiedTarget(page, { ref, text, selector, toLeftOf, toRightOf, above, below });
		if (error || !elementHandle) {
			return result([textPart(error || 'Could not find element.')]);
		}
		
		await elementHandle.selectOption(values);
		return result([textPart(`Selected option in ${element || text || selector || ref}`)]);
	}
}

export interface FieldSpec { name: string; type: 'textbox'|'checkbox'|'radio'|'combobox'; ref: string; value: string; }
export interface FillFormParams { fields: FieldSpec[]; }
export class FillFormTool implements vscode.LanguageModelTool<FillFormParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FillFormParams>) {
		const preview = options.input.fields.slice(0, 5).map((f: FieldSpec) => `${f.name} (${f.ref}): ${f.value}`).join('\n');
		return {
			invocationMessage: 'Fill form fields',
			confirmationMessages: {
				title: 'Fill form',
				message: new vscode.MarkdownString('Fields to fill:\n```\n' + preview + '\n```')
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<FillFormParams>) {
		for (const f of options.input.fields) {
			const elementHandle = BrowserManager.getElementByRef(f.ref);
			if (!elementHandle) {
				throw new Error(`Element ref "${f.ref}" for field "${f.name}" not found. Take a snapshot first using explorer_snapshot to get element references.`);
			}
			
			switch (f.type) {
				case 'textbox':
					await elementHandle.fill(f.value);
					break;
				case 'checkbox':
					await elementHandle.setChecked(f.value.toLowerCase() === 'true');
					break;
				case 'radio':
					await elementHandle.check();
					break;
				case 'combobox':
					await elementHandle.selectOption({ label: f.value });
					break;
			}
		}
		return result([textPart(`Filled ${options.input.fields.length} field(s)`)]);
	}
}

export interface ScreenshotParams { type?: 'png'|'jpeg'; fullPage?: boolean; element?: string; ref?: string; outputPath?: string; }
export class ScreenshotTool implements vscode.LanguageModelTool<ScreenshotParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ScreenshotParams>) {
		const target = options.input.element ? ` of ${options.input.element}` : ' of page';
		return {
			invocationMessage: `Capture screenshot${target}`,
			confirmationMessages: {
				title: 'Screenshot',
				message: new vscode.MarkdownString(`Screenshot${target}${options.input.fullPage ? ' (full page)' : ''}${options.input.outputPath ? `\\n**Save to:** ${options.input.outputPath}` : ''}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ScreenshotParams>) {
		const ext = options.input.type ?? 'png';
		// Use outputPath if provided, otherwise use temp directory
		const filePath = options.input.outputPath?.trim() || path.join(os.tmpdir(), `webexplorer-${Date.now()}.${ext}`);
		
		if (options.input.ref) {
			const elementHandle = BrowserManager.getElementByRef(options.input.ref);
			if (!elementHandle) {
				throw new Error(`Element ref "${options.input.ref}" not found. Take a snapshot first using explorer_snapshot to get element references.`);
			}
			await elementHandle.screenshot({ path: filePath, type: ext as any });
		} else {
			const page = await BrowserManager.getPage();
			await page.screenshot({ path: filePath, type: ext as any, fullPage: options.input.fullPage ?? false });
		}
		return result([textPart(`Saved screenshot to ${filePath}`)]);
	}
}

// Additional tools to match Playwright MCP coverage

export interface CloseParams {}
export class CloseTool implements vscode.LanguageModelTool<CloseParams> {
	async prepareInvocation() {
		return { invocationMessage: 'Close browser page', confirmationMessages: { title: 'Close browser', message: new vscode.MarkdownString('Close the current browser page and session.') } };
	}
	async invoke() {
		await BrowserManager.dispose();
		return result([textPart('Browser closed')]);
	}
}

export interface ConsoleParams { onlyErrors?: boolean }
export class ConsoleMessagesTool implements vscode.LanguageModelTool<ConsoleParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ConsoleParams>) {
		return { invocationMessage: 'Get console messages', confirmationMessages: { title: 'Console messages', message: new vscode.MarkdownString(options.input.onlyErrors ? 'Only errors' : 'All messages') } };
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ConsoleParams>) {
		await BrowserManager.getPage();
		const items = BrowserManager.getConsoleMessages(options.input.onlyErrors);
		return result([textPart(JSON.stringify(items, null, 2))]);
	}
}

export interface DragParams { startElement: string; startRef: string; endElement: string; endRef: string; }
export class DragTool implements vscode.LanguageModelTool<DragParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<DragParams>) {
		return {
			invocationMessage: `Drag ${options.input.startElement} to ${options.input.endElement}`,
			confirmationMessages: {
				title: 'Drag and drop',
				message: new vscode.MarkdownString(`From: ${options.input.startElement} (${options.input.startRef})\nTo: ${options.input.endElement} (${options.input.endRef})`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<DragParams>) {
		const startHandle = BrowserManager.getElementByRef(options.input.startRef);
		const endHandle = BrowserManager.getElementByRef(options.input.endRef);
		
		if (!startHandle) {
			throw new Error(`Start element ref "${options.input.startRef}" not found. Take a snapshot first using explorer_snapshot to get element references.`);
		}
		if (!endHandle) {
			throw new Error(`End element ref "${options.input.endRef}" not found. Take a snapshot first using explorer_snapshot to get element references.`);
		}
		
		// Perform drag using bounding boxes
		const page = await BrowserManager.getPage();
		const startBox = await startHandle.boundingBox();
		const endBox = await endHandle.boundingBox();
		
		if (!startBox || !endBox) {
			throw new Error('Could not get bounding boxes for drag operation');
		}
		
		// Drag from center of start to center of end
		await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2);
		await page.mouse.up();
		
		return result([textPart(`Dragged ${options.input.startElement} to ${options.input.endElement}`)]);
	}
}

export interface EvaluateParams { function: string; element?: string; ref?: string; }
export class EvaluateTool implements vscode.LanguageModelTool<EvaluateParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<EvaluateParams>) {
		const context = options.input.element ? ` on ${options.input.element}` : ' in page context';
		return {
			invocationMessage: 'Evaluate JavaScript',
			confirmationMessages: {
				title: 'Evaluate JS',
				message: new vscode.MarkdownString(`Function will run${context}`)
			}
		};
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<EvaluateParams>) {
		const fnText = options.input.function;
		try {
			if (options.input.ref) {
				const elementHandle = BrowserManager.getElementByRef(options.input.ref);
				if (!elementHandle) {
					throw new Error(`Element ref "${options.input.ref}" not found. Take a snapshot first using explorer_snapshot to get element references.`);
				}
				const out = await elementHandle.evaluate(new Function('element', `return (${fnText})(element);`) as any);
				return result([textPart(typeof out === 'string' ? out : JSON.stringify(out))]);
			} else {
				const page = await BrowserManager.getPage();
				const out = await page.evaluate((new Function(`return (${fnText})()`)) as any);
				return result([textPart(typeof out === 'string' ? out : JSON.stringify(out))]);
			}
		} catch (e: any) {
			throw new Error(`Failed to evaluate function. Provide a valid function expression like '(el)=>el.textContent' or '()=>document.title'. Error: ${e?.message || e}`);
		}
	}
}

export interface FileUploadParams { selector?: string; paths?: string[] }
export class FileUploadTool implements vscode.LanguageModelTool<FileUploadParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FileUploadParams>) {
		return { invocationMessage: 'Upload files', confirmationMessages: { title: 'Upload files', message: new vscode.MarkdownString(`Files: ${(options.input.paths||[]).join(', ')}`) } };
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<FileUploadParams>) {
		const page = await BrowserManager.getPage();
		const files = options.input.paths || [];
		if (options.input.selector) {
			const input = page.locator(options.input.selector).first();
			await input.setInputFiles(files);
		} else {
			const [chooser] = await Promise.all([
				page.waitForEvent('filechooser', { timeout: 5000 }),
			]);
			await chooser.setFiles(files);
		}
		return result([textPart(`Uploaded ${files.length} file(s)`) ]);
	}
}

export interface HandleDialogParams { accept: boolean; promptText?: string }
export class HandleDialogTool implements vscode.LanguageModelTool<HandleDialogParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<HandleDialogParams>) {
		return { invocationMessage: 'Handle dialog', confirmationMessages: { title: 'Dialog', message: new vscode.MarkdownString(options.input.accept ? 'Accept' : 'Dismiss') } };
	}
	async invoke(options: vscode.LanguageModelToolInvocationOptions<HandleDialogParams>) {
		await BrowserManager.getPage();
		// Check if a dialog was already auto-handled
		const lastDialog = BrowserManager.getLastDialogInfo();
		if (lastDialog && lastDialog.handled) {
			const info = BrowserManager.pickDialogInfo();
			return result([textPart(`Dialog already auto-handled (${info?.response}). Type: ${info?.type}, Message: "${info?.message}"`)]);
		}
		// Pre-configure for the next dialog
		BrowserManager.setNextDialogAction(options.input.accept, options.input.promptText);
		return result([textPart(`Dialog handler configured: will ${options.input.accept ? 'accept' : 'dismiss'} the next dialog.`)]);
	}
}

export interface NavigateBackParams {}
export class NavigateBackTool implements vscode.LanguageModelTool<NavigateBackParams> {
	async prepareInvocation() { return { invocationMessage: 'Go back', confirmationMessages: { title: 'Navigate back', message: new vscode.MarkdownString('Go back to previous page') } }; }
	async invoke() { const page = await BrowserManager.getPage(); await page.goBack(); return result([textPart('Navigated back')]); }
}

export interface NetworkRequestsParams {}
export class NetworkRequestsTool implements vscode.LanguageModelTool<NetworkRequestsParams> {
	async prepareInvocation() { return { invocationMessage: 'Get network requests', confirmationMessages: { title: 'Network', message: new vscode.MarkdownString('Return requests since load') } }; }
	async invoke() { await BrowserManager.getPage(); const items = BrowserManager.getNetworkRequests(); return result([textPart(JSON.stringify(items, null, 2))]); }
}

export interface PressKeyParams { key: string }
export class PressKeyTool implements vscode.LanguageModelTool<PressKeyParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<PressKeyParams>) { return { invocationMessage: 'Press key', confirmationMessages: { title: 'Press key', message: new vscode.MarkdownString(options.input.key) } }; }
	async invoke(options: vscode.LanguageModelToolInvocationOptions<PressKeyParams>) { const page = await BrowserManager.getPage(); await page.keyboard.press(options.input.key); return result([textPart('Pressed key')]); }
}

export interface SnapshotParams {}
export class SnapshotTool implements vscode.LanguageModelTool<SnapshotParams> {
	async prepareInvocation() {
		return {
			invocationMessage: 'Get accessibility snapshot',
			confirmationMessages: {
				title: 'Accessibility snapshot',
				message: new vscode.MarkdownString('Capture page accessibility tree with element references')
			}
		};
	}

	async invoke() {
		const page = await BrowserManager.getPage();
		
		// Clear previous refs before taking new snapshot
		BrowserManager.clearElementRefs();
		
		// Use ariaSnapshot() which is available in modern Playwright
		const ariaTree = await page.locator('body').ariaSnapshot();
		
		// Register interactive elements and inject refs into the aria tree
		const interactiveSelector = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="menuitem"], [role="tab"], [role="switch"], [role="slider"], [role="option"]';
		const handles = await page.locator(interactiveSelector).elementHandles();
		
		// Build a map of element descriptions to ref IDs
		const refMap: { match: string; ref: string }[] = [];
		for (const handle of handles) {
			try {
				const refId = BrowserManager.registerElement(handle);
				// Get identifying info for matching into the aria tree
				const info = await handle.evaluate((el: Element) => {
					const tag = el.tagName.toLowerCase();
					const role = el.getAttribute('role') || '';
					const ariaLabel = el.getAttribute('aria-label') || '';
					const text = (el.textContent || '').trim().substring(0, 60);
					const type = el.getAttribute('type') || '';
					const name = el.getAttribute('name') || '';
					const id = el.getAttribute('id') || '';
					const placeholder = el.getAttribute('placeholder') || '';
					return { tag, role, ariaLabel, text, type, name, id, placeholder };
				});
				refMap.push({ match: JSON.stringify(info), ref: refId });
			} catch { /* skip detached elements */ }
		}
		
		// Build output with refs annotated into the aria tree lines
		const lines = ariaTree.split('\n');
		const annotatedLines: string[] = [];
		const usedRefs = new Set<string>();
		
		for (const line of lines) {
			let annotatedLine = line;
			// Try to match refs to aria tree lines by looking for quoted names
			const nameMatch = line.match(/- (\w+) "([^"]+)"/);
			if (nameMatch) {
				const [, ariaRole, ariaName] = nameMatch;
				// Find a matching ref
				for (const { match, ref } of refMap) {
					if (usedRefs.has(ref)) continue;
					const info = JSON.parse(match);
					const textMatch = info.text && ariaName && (
						info.text.includes(ariaName) || ariaName.includes(info.text)
					);
					const labelMatch = info.ariaLabel && ariaName && (
						info.ariaLabel.includes(ariaName) || ariaName.includes(info.ariaLabel)
					);
					if (textMatch || labelMatch) {
						annotatedLine = line.replace(/("(?:[^"]*)")/, `$1 [ref=${ref}]`);
						usedRefs.add(ref);
						break;
					}
				}
			}
			// Also match unnamed interactive elements (e.g. "- textbox" without a quoted name)
			const unnamedMatch = line.match(/^(\s*- )(textbox|button|checkbox|radio|combobox|searchbox|link|slider|switch|tab|menuitem)(\s|$)/);
			if (unnamedMatch && !annotatedLine.includes('[ref=')) {
				const [, prefix, ariaRole] = unnamedMatch;
				for (const { match, ref } of refMap) {
					if (usedRefs.has(ref)) continue;
					const info = JSON.parse(match);
					const roleMatches = info.role === ariaRole || 
						(ariaRole === 'textbox' && (info.tag === 'input' || info.tag === 'textarea')) ||
						(ariaRole === 'button' && info.tag === 'button') ||
						(ariaRole === 'link' && info.tag === 'a') ||
						(ariaRole === 'combobox' && info.tag === 'select') ||
						(ariaRole === 'checkbox' && info.type === 'checkbox') ||
						(ariaRole === 'radio' && info.type === 'radio');
					if (roleMatches) {
						annotatedLine = annotatedLine.replace(ariaRole, `${ariaRole} [ref=${ref}]`);
						usedRefs.add(ref);
						break;
					}
				}
			}
			annotatedLines.push(annotatedLine);
		}
		
		const output: string[] = [];
		output.push(`- Page URL: ${page.url()}`);
		output.push(`- Page Title: ${await page.title()}`);
		output.push('- Page Snapshot:');
		output.push('```yaml');
		output.push(...annotatedLines);
		output.push('```');
		
		// Append ref summary for unmatched elements
		const unmatchedRefs = refMap.filter(r => !usedRefs.has(r.ref));
		if (unmatchedRefs.length > 0) {
			output.push('');
			output.push('Additional interactive elements:');
			for (const { match, ref } of unmatchedRefs.slice(0, 20)) {
				const info = JSON.parse(match);
				const desc = info.ariaLabel || info.text || info.placeholder || `${info.tag}${info.type ? `[type=${info.type}]` : ''}${info.id ? `#${info.id}` : ''}`;
				output.push(`  [ref=${ref}] ${desc}`);
			}
		}
		
		return result([textPart(output.join('\n'))]);
	}
}

export interface TabsParams { action: 'list'|'new'|'close'|'select'; index?: number }
export class TabsTool implements vscode.LanguageModelTool<TabsParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<TabsParams>) { return { invocationMessage: 'Manage tabs', confirmationMessages: { title: 'Tabs', message: new vscode.MarkdownString(`Action: ${options.input.action}${options.input.index?` index: ${options.input.index}`:''}`) } }; }
	async invoke(options: vscode.LanguageModelToolInvocationOptions<TabsParams>) {
		const page = await BrowserManager.getPage();
		const ctx = page.context();
		if (options.input.action === 'list') {
			const tabs = await BrowserManager.listTabs();
			return result([textPart(JSON.stringify(tabs, null, 2))]);
		}
		if (options.input.action === 'new') {
			await BrowserManager.newTab();
			return result([textPart('Opened new tab')]);
		}
		if (options.input.action === 'select') {
			if (!options.input.index) throw new Error('Provide index to select');
			await BrowserManager.selectTab(options.input.index);
			return result([textPart(`Selected tab ${options.input.index}`)]);
		}
		if (options.input.action === 'close') {
			if (options.input.index) {
				const pages = ctx.pages();
				const i = Math.max(0, Math.min(options.input.index - 1, pages.length - 1));
				await pages[i].close();
			} else {
				await (await BrowserManager.getPage()).close();
			}
			return result([textPart('Closed tab')]);
		}
		return result([textPart('No-op')]);
	}
}

export interface InstallBrowserParams {}
export class InstallBrowserTool implements vscode.LanguageModelTool<InstallBrowserParams> {
	async prepareInvocation() { return { invocationMessage: 'Install browser (no-op)', confirmationMessages: { title: 'Install browser', message: new vscode.MarkdownString('This extension uses your system Chrome or Edge; installation is not required.') } }; }
	async invoke() { return result([textPart('No installation performed. Set WEBEXPLORER_BROWSER=chrome|msedge if needed.')]); }
}

// ============================================================================
// HELIUM-STYLE TOOLS: Text-based and relative positioning element interaction
// ============================================================================

/**
 * explorer_find - Find elements by visible text, relative position, or selector
 * Similar to Helium's approach in Python for web automation
 */
export interface FindParams {
	text?: string;           // Visible text to search for
	selector?: string;       // CSS selector, xpath=..., link=..., text=...
	near?: string;           // Find element near this text (any direction)
	toLeftOf?: string;       // Find element to the left of this text
	toRightOf?: string;      // Find element to the right of this text
	above?: string;          // Find element above this text
	below?: string;          // Find element below this text
	index?: number;          // If multiple matches, select by index (0-based)
}

export class FindTool implements vscode.LanguageModelTool<FindParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FindParams>) {
		const { text, selector, near, toLeftOf, toRightOf, above, below } = options.input;
		let desc = '';
		if (text) desc = `text="${text}"`;
		else if (selector) desc = `selector="${selector}"`;
		if (near) desc += ` near "${near}"`;
		if (toLeftOf) desc += ` to left of "${toLeftOf}"`;
		if (toRightOf) desc += ` to right of "${toRightOf}"`;
		if (above) desc += ` above "${above}"`;
		if (below) desc += ` below "${below}"`;
		
		return {
			invocationMessage: `Finding element: ${desc}`,
			confirmationMessages: {
				title: 'Find element',
				message: new vscode.MarkdownString(`Search for: ${desc}`)
			}
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FindParams>) {
		const page = await BrowserManager.getPage();
		const { text, selector, near, toLeftOf, toRightOf, above, below, index } = options.input;

		try {
			let elements: any[] = [];
			
			// Step 1: Find candidate elements
			if (selector) {
				// Use provided selector
				const locator = getLocator(page, selector);
				const count = await locator.count();
				for (let i = 0; i < count; i++) {
					elements.push(await locator.nth(i).elementHandle());
				}
			} else if (text) {
				// Find by visible text
				const locator = page.getByText(text, { exact: false });
				const count = await locator.count();
				for (let i = 0; i < count; i++) {
					elements.push(await locator.nth(i).elementHandle());
				}
			} else {
				// Find all interactive elements if no text/selector specified
				const interactiveSelector = 'input, textarea, button, a, select, [role="button"], [role="link"], [role="textbox"], [onclick]';
				const locator = page.locator(interactiveSelector);
				const count = await locator.count();
				for (let i = 0; i < Math.min(count, 100); i++) { // Limit to 100
					elements.push(await locator.nth(i).elementHandle());
				}
			}

			// Step 2: Filter by relative position if specified
			if (elements.length > 0 && (near || toLeftOf || toRightOf || above || below)) {
				const referenceText = near || toLeftOf || toRightOf || above || below;
				const refLocator = page.getByText(referenceText!, { exact: false });
				const refCount = await refLocator.count();
				
				if (refCount === 0) {
					return result([textPart(`Reference text "${referenceText}" not found on page.`)]);
				}
				
				const refElement = await refLocator.first().elementHandle();
				const refBox = await refElement?.boundingBox();
				
				if (!refBox) {
					return result([textPart(`Could not get position of reference element.`)]);
				}

				// Filter elements based on relative position
				const filteredElements: any[] = [];
				for (const el of elements) {
					const box = await el.boundingBox();
					if (!box) continue;
					
					const elCenterX = box.x + box.width / 2;
					const elCenterY = box.y + box.height / 2;
					const refCenterX = refBox.x + refBox.width / 2;
					const refCenterY = refBox.y + refBox.height / 2;
					
					let matches = false;
					
					if (near) {
						// Within 200px in any direction
						const distance = Math.sqrt(Math.pow(elCenterX - refCenterX, 2) + Math.pow(elCenterY - refCenterY, 2));
						matches = distance < 200;
					} else if (toLeftOf) {
						// Element is to the left of reference
						matches = elCenterX < refBox.x && Math.abs(elCenterY - refCenterY) < 50;
					} else if (toRightOf) {
						// Element is to the right of reference
						matches = elCenterX > refBox.x + refBox.width && Math.abs(elCenterY - refCenterY) < 50;
					} else if (above) {
						// Element is above reference
						matches = elCenterY < refBox.y && Math.abs(elCenterX - refCenterX) < 100;
					} else if (below) {
						// Element is below reference
						matches = elCenterY > refBox.y + refBox.height && Math.abs(elCenterX - refCenterX) < 100;
					}
					
					if (matches) {
						filteredElements.push(el);
					}
				}
				elements = filteredElements;
			}

			if (elements.length === 0) {
				return result([textPart('No elements found matching the criteria.')]);
			}

			// Step 3: Select element by index or return info about matches
			const selectedIndex = index ?? 0;
			if (selectedIndex >= elements.length) {
				return result([textPart(`Only ${elements.length} elements found, but index ${selectedIndex} requested.`)]);
			}

			const selectedElement = elements[selectedIndex];
			
			// Register the element for later interaction
			const refId = BrowserManager.registerElement(selectedElement);
			
			// Get element info for display
			const box = await selectedElement.boundingBox();
			const tagName = await selectedElement.evaluate((el: Element) => el.tagName.toLowerCase());
			const id = await selectedElement.getAttribute('id');
			const className = await selectedElement.getAttribute('class');
			const textContent = await selectedElement.evaluate((el: Element) => (el.textContent || '').trim().substring(0, 50));
			const inputType = await selectedElement.getAttribute('type');
			const placeholder = await selectedElement.getAttribute('placeholder');
			
			let info = `Found ${elements.length} element(s). Selected element [ref=${refId}]:\n`;
			info += `  Tag: <${tagName}${inputType ? ` type="${inputType}"` : ''}>\n`;
			if (id) info += `  ID: ${id}\n`;
			if (className) info += `  Class: ${className.substring(0, 50)}${className.length > 50 ? '...' : ''}\n`;
			if (placeholder) info += `  Placeholder: ${placeholder}\n`;
			if (textContent) info += `  Text: "${textContent}${textContent.length >= 50 ? '...' : ''}"\n`;
			if (box) info += `  Position: (${Math.round(box.x)}, ${Math.round(box.y)}) Size: ${Math.round(box.width)}x${Math.round(box.height)}\n`;
			info += `\nUse explorer_interact with ref="${refId}" to interact with this element.`;
			
			return result([textPart(info)]);
		} catch (error: any) {
			return result([textPart(`Error finding element: ${error.message}`)]);
		}
	}
}

/**
 * explorer_interact - Interact with elements found by explorer_find or by direct selector/text
 * Supports click, type, hover, clear, select, and other common actions
 */
export interface InteractParams {
	ref?: string;            // Element reference from explorer_find
	text?: string;           // Find by visible text (alternative to ref)
	selector?: string;       // Find by selector (alternative to ref)
	action: 'click' | 'type' | 'hover' | 'clear' | 'select' | 'focus' | 'check' | 'uncheck' | 'press';
	value?: string;          // Value for type/select/press actions
	// Relative positioning (same as FindParams)
	toLeftOf?: string;
	toRightOf?: string;
	above?: string;
	below?: string;
}

export class InteractTool implements vscode.LanguageModelTool<InteractParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<InteractParams>) {
		const { ref, text, selector, action, value, toLeftOf, toRightOf, above, below } = options.input;
		let target = ref ? `ref=${ref}` : (text ? `text="${text}"` : `selector="${selector}"`);
		if (toLeftOf) target += ` to left of "${toLeftOf}"`;
		if (toRightOf) target += ` to right of "${toRightOf}"`;
		if (above) target += ` above "${above}"`;
		if (below) target += ` below "${below}"`;
		
		return {
			invocationMessage: `${action} on ${target}${value ? ` with value "${value}"` : ''}`,
			confirmationMessages: {
				title: `Interact: ${action}`,
				message: new vscode.MarkdownString(`**Action:** ${action}\n**Target:** ${target}${value ? `\n**Value:** ${value}` : ''}`)
			}
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<InteractParams>) {
		const page = await BrowserManager.getPage();
		const { ref, text, selector, action, value, toLeftOf, toRightOf, above, below } = options.input;

		try {
			let element: any = null;

			// Get element by ref, text, or selector
			if (ref) {
				element = BrowserManager.getElementByRef(ref);
				if (!element) {
					return result([textPart(`Element with ref="${ref}" not found. Use explorer_find or explorer_snapshot first.`)]);
				}
			} else if (text || selector) {
				// Find element directly
				let locator: any;
				if (text) {
					locator = page.getByText(text, { exact: false });
				} else {
					locator = getLocator(page, selector!);
				}
				
				// Apply relative positioning if specified
				if (toLeftOf || toRightOf || above || below) {
					const referenceText = toLeftOf || toRightOf || above || below;
					const refLocator = page.getByText(referenceText!, { exact: false });
					const refElement = await refLocator.first().elementHandle();
					const refBox = await refElement?.boundingBox();
					
					if (!refBox) {
						return result([textPart(`Reference element "${referenceText}" not found.`)]);
					}
					
					// Find all candidates and filter by position
					const count = await locator.count();
					for (let i = 0; i < count; i++) {
						const el = await locator.nth(i).elementHandle();
						const box = await el?.boundingBox();
						if (!box) continue;
						
						const elCenterX = box.x + box.width / 2;
						const elCenterY = box.y + box.height / 2;
						const refCenterX = refBox.x + refBox.width / 2;
						const refCenterY = refBox.y + refBox.height / 2;
						
						let matches = false;
						if (toLeftOf) matches = elCenterX < refBox.x && Math.abs(elCenterY - refCenterY) < 50;
						else if (toRightOf) matches = elCenterX > refBox.x + refBox.width && Math.abs(elCenterY - refCenterY) < 50;
						else if (above) matches = elCenterY < refBox.y && Math.abs(elCenterX - refCenterX) < 100;
						else if (below) matches = elCenterY > refBox.y + refBox.height && Math.abs(elCenterX - refCenterX) < 100;
						
						if (matches) {
							element = el;
							break;
						}
					}
					
					if (!element) {
						return result([textPart(`No element found matching position criteria.`)]);
					}
				} else {
					element = await locator.first().elementHandle();
				}
				
				if (!element) {
					return result([textPart(`Element not found.`)]);
				}
			} else {
				return result([textPart('Provide ref, text, or selector to identify the element.')]);
			}

			// Perform the action
			switch (action) {
				case 'click':
					await element.click();
					return result([textPart('Clicked on element.')]);
					
				case 'type':
					if (!value) return result([textPart('Provide value to type.')]);
					await element.fill(value);
					return result([textPart(`Typed "${value}" into element.`)]);
					
				case 'hover':
					await element.hover();
					return result([textPart('Hovered over element.')]);
					
				case 'clear':
					await element.fill('');
					return result([textPart('Cleared element.')]);
					
				case 'select':
					if (!value) return result([textPart('Provide value to select.')]);
					await element.selectOption(value);
					return result([textPart(`Selected option "${value}".`)]);
					
				case 'focus':
					await element.focus();
					return result([textPart('Focused on element.')]);
					
				case 'check':
					await element.check();
					return result([textPart('Checked the checkbox/radio.')]);
					
				case 'uncheck':
					await element.uncheck();
					return result([textPart('Unchecked the checkbox.')]);
					
				case 'press':
					if (!value) return result([textPart('Provide key to press (e.g., "Enter", "Tab").')]);
					await element.press(value);
					return result([textPart(`Pressed "${value}" key.`)]);
					
				default:
					return result([textPart(`Unknown action: ${action}`)]);
			}
		} catch (error: any) {
			return result([textPart(`Error: ${error.message}`)]);
		}
	}
}

// ============================================================================
// SCRAPING TOOLS: Specialized tools for extracting navigation maps and page content
// ============================================================================

/**
 * explorer_scrape_menu - Extract hierarchical menu/navigation structure from the page
 * Designed for MUI-based sidebars and similar navigation patterns
 */
export interface ScrapeMenuParams {
	menuSelector?: string;      // CSS selector for menu items (default: [class*="MenuItem_level3Text"])
	containerSelector?: string; // CSS selector for the menu container (default: nav, [role="navigation"], .sidebar)
	expanderSelector?: string;  // CSS selector for expand/collapse buttons
	expandTimeout?: number;     // Timeout in ms for menu expansion (default: 2000)
	maxDepth?: number;          // Maximum depth to traverse (default: 5)
	includeUrls?: boolean;      // Whether to extract URLs/hrefs (default: true)
	outputPath?: string;        // Optional file path to save JSON output
}

export class ScrapeMenuTool implements vscode.LanguageModelTool<ScrapeMenuParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ScrapeMenuParams>) {
		const selector = options.input.menuSelector || '[class*="MenuItem_level3Text"]';
		return {
			invocationMessage: `Scraping menu structure using selector: ${selector}`,
			confirmationMessages: {
				title: 'Scrape Menu',
				message: new vscode.MarkdownString(`Extract navigation menu structure.\n\n**Selector:** \`${selector}\`\n**Max Depth:** ${options.input.maxDepth || 5}`)
			}
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ScrapeMenuParams>) {
		const page = await BrowserManager.getPage();
		const {
			menuSelector = '[class*="MenuItem_level3Text"]',
			containerSelector = 'nav, [role="navigation"], .sidebar, [class*="sidebar"], [class*="Sidebar"], aside, [data-testid*="menu"], [class*="Drawer"], body',
			expanderSelector = '[class*="expand"], [class*="chevron"], [aria-expanded], .MuiCollapse-root, [class*="arrow"]',
			expandTimeout = 2000,
			maxDepth = 5,
			includeUrls = true
		} = options.input;

		try {
			// Inject the menu scraping script
			const menuData = await page.evaluate(async ({ menuSelector, containerSelector, expanderSelector, expandTimeout, maxDepth, includeUrls }: any) => {
				const errors: Array<{item: string, error: string, path: string}> = [];
				
				// Helper: sleep
				const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

				// Strategy 1: DOM-based hierarchy (ul/li nesting) - works for traditional HTML menus
				const scrapeByDOMStructure = (container: Element): any[] => {
					const result: any[] = [];
					
					// Find top-level list items or menu sections
					const topLevelLists = container.querySelectorAll(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol');
					
					if (topLevelLists.length > 0) {
						// Traditional nested list structure
						for (const list of Array.from(topLevelLists)) {
							const items = scrapeList(list as Element, 0);
							result.push(...items);
						}
					} else {
						// Try finding links grouped by headers
						const sections = findSectionsByHeaders(container);
						result.push(...sections);
					}
					
					return result;
				};
				
				// Recursively scrape nested ul/li structure
				const scrapeList = (list: Element, depth: number): any[] => {
					if (depth > maxDepth) return [];
					const items: any[] = [];
					
					// Get direct child li elements
					const listItems = list.querySelectorAll(':scope > li');
					
					for (const li of Array.from(listItems)) {
						// Find the link or text for this item
						const link = li.querySelector(':scope > a, :scope > span > a, :scope > div > a');
						const textEl = link || li.querySelector(':scope > span, :scope > div') || li;
						
						// Get text - prefer direct text content, exclude nested items
						let name = '';
						if (link) {
							name = link.textContent?.trim() || '';
						} else {
							// Get only direct text, not from nested lists
							const clone = li.cloneNode(true) as Element;
							const nestedLists = clone.querySelectorAll('ul, ol');
							nestedLists.forEach(nl => nl.remove());
							name = clone.textContent?.trim() || '';
						}
						
						if (!name) continue;
						
						const item: any = {
							name,
							url: includeUrls && link ? (link as HTMLAnchorElement).getAttribute('href') || undefined : undefined,
							children: []
						};
						
						// Look for nested ul/ol
						const nestedList = li.querySelector(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol');
						if (nestedList) {
							item.children = scrapeList(nestedList as Element, depth + 1);
						}
						
						items.push(item);
					}
					
					return items;
				};
				
				// Find sections by looking for header patterns (for sites without proper nesting)
				const findSectionsByHeaders = (container: Element): any[] => {
					const result: any[] = [];
					
					// Look for links that appear to be category headers (e.g., all caps, bold, larger)
					const allLinks = container.querySelectorAll('a[href]');
					const linkArray = Array.from(allLinks);
					
					// Group by parent container to detect hierarchy
					const parentMap = new Map<Element, {header: Element | null, items: Element[]}>();
					
					for (const link of linkArray) {
						// Find the nearest list container or section
						const listParent = link.closest('ul, ol, div[class*="menu"], div[class*="nav"]');
						if (!listParent) continue;
						
						if (!parentMap.has(listParent)) {
							parentMap.set(listParent, { header: null, items: [] });
						}
						
						const group = parentMap.get(listParent)!;
						
						// Check if this looks like a header (all caps, or class suggests it)
						const text = link.textContent?.trim() || '';
						const isHeader = /^[A-Z\s&]+$/.test(text) && text.length > 2 && text.length < 50;
						
						if (isHeader && !group.header) {
							group.header = link;
						} else {
							group.items.push(link);
						}
					}
					
					// Convert groups to menu items
					for (const [parent, group] of parentMap) {
						if (group.header) {
							const headerLink = group.header as HTMLAnchorElement;
							const item: any = {
								name: headerLink.textContent?.trim() || '',
								url: includeUrls ? headerLink.getAttribute('href') || undefined : undefined,
								children: group.items.map(link => ({
									name: (link as HTMLAnchorElement).textContent?.trim() || '',
									url: includeUrls ? (link as HTMLAnchorElement).getAttribute('href') || undefined : undefined,
									children: []
								})).filter(i => i.name)
							};
							if (item.name) result.push(item);
						}
					}
					
					return result;
				};

				// Strategy 2: Generic class-based hierarchy detection
				// Works by analyzing the DOM to auto-detect level patterns
				const scrapeByClassLevels = (container: Element, selector: string): any[] => {
					const items = Array.from(container.querySelectorAll(selector)) as Element[];
					if (items.length === 0) return [];
					
					const result: any[] = [];
					const stack: { item: any; level: number }[] = [];
					const processedTexts = new Set<string>();
					
					// ============================================
					// STEP 1: Auto-detect the hierarchy pattern
					// ============================================
					
					// Analyze all items to detect patterns
					const classAnalysis = items.map(item => {
						const className = (item as HTMLElement).className || '';
						const classTokens = className.split(/\s+/).filter(c => c);
						const computedStyle = window.getComputedStyle(item as HTMLElement);
						const depth = getElementDepth(item, container);
						const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
						const marginLeft = parseFloat(computedStyle.marginLeft) || 0;
						const indent = paddingLeft + marginLeft;
						const fontSize = parseFloat(computedStyle.fontSize) || 14;
						
						return {
							element: item,
							className,
							classTokens,
							depth,
							indent,
							fontSize,
							text: item.textContent?.trim() || ''
						};
					});
					
					// Helper to get DOM depth relative to container
					function getElementDepth(el: Element, container: Element): number {
						let depth = 0;
						let current = el.parentElement;
						while (current && current !== container) {
							depth++;
							current = current.parentElement;
						}
						return depth;
					}
					
					// ============================================
					// STEP 2: Determine level detection method
					// ============================================
					
					type LevelDetector = (item: Element, analysis: typeof classAnalysis[0]) => number;
					let detectLevel: LevelDetector;
					let detectionMethod = 'unknown';
					let maxLevel = 2; // Default max depth
					
					// Method A: Explicit level classes (level0, level1, level-2, etc.)
					const hasExplicitLevels = classAnalysis.some(a => 
						a.classTokens.some(c => /^level[-_]?\d+$/i.test(c))
					);
					
					// Method B: Saviynt-style pattern (MenuItem_level3Label, false, jss*)
					const hasSaviyntPattern = classAnalysis.some(a => 
						a.classTokens.some(c => c.includes('MenuItem_level')) ||
						(a.classTokens.includes('false') && a.classTokens.some(c => /^jss\d+$/.test(c)))
					);
					
					// Method C: Indentation-based (padding/margin varies by level)
					const indentValues = [...new Set(classAnalysis.map(a => Math.round(a.indent / 10) * 10))].sort((a, b) => a - b);
					const hasIndentLevels = indentValues.length >= 2 && indentValues[indentValues.length - 1] - indentValues[0] >= 15;
					
					// Method D: DOM depth-based (nested deeper = higher level)
					const depthValues = [...new Set(classAnalysis.map(a => a.depth))].sort((a, b) => a - b);
					const hasDepthLevels = depthValues.length >= 2;
					
					// Method E: Font size hierarchy (larger = parent)
					const fontSizes = [...new Set(classAnalysis.map(a => Math.round(a.fontSize)))].sort((a, b) => b - a);
					const hasFontHierarchy = fontSizes.length >= 2 && fontSizes[0] - fontSizes[fontSizes.length - 1] >= 2;
					
					// Method F: aria-level attribute
					const hasAriaLevels = classAnalysis.some(a => 
						a.element.hasAttribute('aria-level') || 
						a.element.closest('[aria-level]') !== null
					);
					
					// Choose the best detection method
					if (hasAriaLevels) {
						detectionMethod = 'aria-level';
						detectLevel = (item, analysis) => {
							const ariaLevel = item.getAttribute('aria-level') || 
								item.closest('[aria-level]')?.getAttribute('aria-level');
							return ariaLevel ? parseInt(ariaLevel, 10) - 1 : 0; // aria-level is 1-based
						};
					} else if (hasExplicitLevels) {
						detectionMethod = 'explicit-class';
						detectLevel = (item, analysis) => {
							const levelClass = analysis.classTokens.find(c => /^level[-_]?\d+$/i.test(c));
							if (levelClass) {
								const match = levelClass.match(/\d+/);
								return match ? parseInt(match[0], 10) : 0;
							}
							return 0;
						};
					} else if (hasSaviyntPattern) {
						detectionMethod = 'saviynt-pattern';
						detectLevel = (item, analysis) => {
							const hasLabelClass = analysis.classTokens.some(c => c.includes('MenuItem_level') && c.includes('Label'));
							const hasFalseClass = analysis.classTokens.includes('false');
							const hasJssClass = analysis.classTokens.some(c => /^jss\d+$/.test(c));
							
							if (hasLabelClass) return 2;        // Leaf item
							if (hasFalseClass) return 0;        // Top level
							if (hasJssClass) return 1;          // Category
							return 0;
						};
					} else if (hasIndentLevels) {
						detectionMethod = 'indentation';
						const indentStep = indentValues.length > 1 ? indentValues[1] - indentValues[0] : 20;
						const baseIndent = indentValues[0];
						maxLevel = Math.max(2, indentValues.length - 1);
						detectLevel = (item, analysis) => {
							return Math.min(maxLevel, Math.round((analysis.indent - baseIndent) / Math.max(indentStep, 10)));
						};
					} else if (hasDepthLevels) {
						detectionMethod = 'dom-depth';
						const baseDepth = depthValues[0];
						maxLevel = Math.max(2, depthValues.length - 1);
						detectLevel = (item, analysis) => {
							return Math.min(maxLevel, analysis.depth - baseDepth);
						};
					} else if (hasFontHierarchy) {
						detectionMethod = 'font-size';
						detectLevel = (item, analysis) => {
							const idx = fontSizes.indexOf(Math.round(analysis.fontSize));
							return idx >= 0 ? idx : 0;
						};
					} else {
						// Fallback: treat all as same level (flat list)
						detectionMethod = 'flat';
						detectLevel = () => 0;
						maxLevel = 0;
					}
					
					// ============================================
					// STEP 3: Filter duplicate text nodes (MUI issue)
					// ============================================
					const filteredItems = classAnalysis.filter(analysis => {
						const parent = analysis.element.parentElement;
						// Skip if parent already contains the same text (nested text wrappers)
						if (parent && parent.textContent?.trim() === analysis.text) {
							// Check if parent is also in our list
							const parentInList = classAnalysis.some(a => a.element === parent);
							if (parentInList) return false;
						}
						return true;
					});
					
					// ============================================
					// STEP 4: Build hierarchy using detected levels
					// ============================================
					for (const analysis of filteredItems) {
						const { element: item, text } = analysis;
						if (!text) continue;
						
						// Skip duplicates
						if (processedTexts.has(text)) continue;
						processedTexts.add(text);
						
						const link = item.closest('a') || item.querySelector('a');
						const level = detectLevel(item, analysis);
						
						const menuItem: any = {
							name: text,
							url: includeUrls && link ? (link as HTMLAnchorElement).getAttribute('href') || undefined : undefined,
							children: []
						};
						
						// Build hierarchy based on levels
						while (stack.length > 0 && stack[stack.length - 1].level >= level) {
							stack.pop();
						}
						
						if (stack.length === 0) {
							result.push(menuItem);
						} else {
							stack[stack.length - 1].item.children.push(menuItem);
						}
						
						// Add to stack if it can have children
						if (level < maxLevel) {
							stack.push({ item: menuItem, level });
						}
					}
					
					// Add detection method to help with debugging
					(result as any).__detectionMethod = detectionMethod;
					
					return result;
				};

				// Try to expand collapsed menus first
				const expandMenus = async () => {
					const expanders = document.querySelectorAll(expanderSelector);
					for (const expander of Array.from(expanders)) {
						const ariaExpanded = expander.getAttribute('aria-expanded');
						if (ariaExpanded === 'false') {
							try {
								(expander as HTMLElement).click();
								await sleep(300);
							} catch (e) {
								// Ignore click errors
							}
						}
					}
					await sleep(500);
				};

				// Expand menus first
				await expandMenus();

				// Find the menu container
				let container = document.querySelector(containerSelector);
				if (!container) {
					const firstMenuItem = document.querySelector(menuSelector);
					if (firstMenuItem) {
						container = firstMenuItem.closest('nav, aside, [role="navigation"]') || 
						            firstMenuItem.parentElement?.parentElement || document.body;
					} else {
						container = document.body;
					}
				}

				// Determine which strategy to use
				let hierarchy: any[] = [];
				let strategyUsed = '';
				let detectionMethod = '';
				
				// Check if custom selector was provided (not default)
				const isCustomSelector = menuSelector !== '[class*="MenuItem_level3Text"]';
				const muiItems = container?.querySelectorAll(menuSelector) || [];
				
				// Strategy selection:
				// 1. If custom selector provided, use class-based detection (auto-detects pattern)
				// 2. If items found with selector, use class-based detection
				// 3. Otherwise, try DOM structure first, then fallback
				
				if (muiItems.length > 0) {
					// Use intelligent class-based hierarchy detection
					hierarchy = scrapeByClassLevels(container!, menuSelector);
					detectionMethod = (hierarchy as any).__detectionMethod || 'auto';
					delete (hierarchy as any).__detectionMethod;
					strategyUsed = `class-levels (${detectionMethod})`;
				} else {
					// Use DOM structure for traditional HTML
					hierarchy = scrapeByDOMStructure(container!);
					strategyUsed = 'dom-structure';
					detectionMethod = 'semantic-html';
				}
				
				// If nothing found, try broader selectors
				if (hierarchy.length === 0) {
					const broadSelectors = [
						'nav a, [role="navigation"] a',
						'.sidebar a, aside a',
						'[class*="menu"] a, [class*="Menu"] a',
						'[class*="nav"] a, [class*="Nav"] a'
					];
					
					for (const selector of broadSelectors) {
						const broadItems = container?.querySelectorAll(selector);
						if (broadItems && broadItems.length > 0) {
							hierarchy = scrapeByClassLevels(container!, selector);
							detectionMethod = (hierarchy as any).__detectionMethod || 'broad-search';
							delete (hierarchy as any).__detectionMethod;
							strategyUsed = `broad-search (${detectionMethod})`;
							if (hierarchy.length > 0) break;
						}
					}
				}

				
                // Deduplicate menu items to remove duplicates
                const deduplicateHierarchy = (items: any[]): any[] => {
                    const seen = new Set<string>();
                    const deduplicated: any[] = [];
                    
                    for (const item of items) {
                        // Create unique key based on name and url (or just name if no url)
                        const key = item.url ? `${item.name}|${item.url}` : item.name;
                        
                        if (!seen.has(key)) {
                            seen.add(key);
                            // Recursively deduplicate children
                            const deduplicatedItem = {
                                ...item,
                                children: item.children ? deduplicateHierarchy(item.children) : []
                            };
                            deduplicated.push(deduplicatedItem);
                        }
                    }
                    
                    return deduplicated;
                };

                // Apply deduplication to the hierarchy
                hierarchy = deduplicateHierarchy(hierarchy);

				// Count items
				const countItems = (items: any[]): { total: number; leaves: number } => {
					let total = 0;
					let leaves = 0;
					for (const item of items) {
						total++;
						if (item.children.length === 0) {
							leaves++;
						} else {
							const sub = countItems(item.children);
							total += sub.total;
							leaves += sub.leaves;
						}
					}
					return { total, leaves };
				};
				
				const counts = countItems(hierarchy);

				return {
					menu: hierarchy,
					stats: {
						totalItems: counts.total,
						categoryItems: counts.total - counts.leaves,
						leafItems: counts.leaves,
						containerFound: !!container,
						strategyUsed,
						menuSelector,
						timestamp: new Date().toISOString()
					},
					errors
				};
			}, { menuSelector, containerSelector, expanderSelector, expandTimeout, maxDepth, includeUrls });

			// Format output
			const output = JSON.stringify(menuData, null, 2);
			
			// Summary
			const stats = menuData.stats;
			let summary = `## Menu Scraping Complete\n\n`;
			summary += `- **Total Items:** ${stats.totalItems}\n`;
			summary += `- **Categories:** ${stats.categoryItems}\n`;
			summary += `- **Leaf Items:** ${stats.leafItems}\n`;
			summary += `- **Container Found:** ${stats.containerFound}\n`;
			summary += `- **Strategy Used:** ${stats.strategyUsed}\n\n`;
			
			if (menuData.errors && menuData.errors.length > 0) {
				summary += `### Errors (${menuData.errors.length})\n`;
				for (const err of menuData.errors) {
					summary += `- ${err.item}: ${err.error}\n`;
				}
				summary += '\n';
			}
			
			summary += `### JSON Output\n\`\`\`json\n${output}\n\`\`\``;
			
			// Save to file if outputPath provided
			if (options.input.outputPath) {
				const fileUri = vscode.Uri.file(options.input.outputPath.trim());
				await vscode.workspace.fs.writeFile(fileUri, Buffer.from(output, 'utf8'));
				summary += `\n\n**Saved to:** ${options.input.outputPath}`;
			}
			
			return result([textPart(summary)]);
		} catch (error: any) {
			return result([textPart(`Error scraping menu: ${error.message}`)]);
		}
	}
}

/**
 * explorer_scrape_page - Extract structured page content (forms, tables, filters)
 * Returns JSON schema-compliant data for forms, tables, and filter panels
 */
export interface ScrapePageParams {
	includeFormFields?: boolean;  // Extract form fields (default: true)
	includeTables?: boolean;      // Extract data tables (default: true)
	includeFilters?: boolean;     // Extract filter panels (default: true)
	maxTableRows?: number;        // Max table rows to sample (default: 10)
	formSelector?: string;        // Custom form selector (default: form, [role="form"])
	tableSelector?: string;       // Custom table selector (default: table, [role="grid"])
	outputPath?: string;          // Optional file path to save JSON output
}

export class ScrapePageTool implements vscode.LanguageModelTool<ScrapePageParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ScrapePageParams>) {
		const types: string[] = [];
		if (options.input.includeFormFields !== false) types.push('forms');
		if (options.input.includeTables !== false) types.push('tables');
		if (options.input.includeFilters !== false) types.push('filters');
		
		return {
			invocationMessage: `Scraping page content: ${types.join(', ')}`,
			confirmationMessages: {
				title: 'Scrape Page Content',
				message: new vscode.MarkdownString(`Extract structured content:\n- ${types.join('\n- ')}`)
			}
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ScrapePageParams>) {
		const page = await BrowserManager.getPage();
		const {
			includeFormFields = true,
			includeTables = true,
			includeFilters = true,
			maxTableRows = 10,
			formSelector = 'form, [role="form"], .form, [class*="form"]',
			tableSelector = 'table, [role="grid"], .table, [class*="table"], [class*="DataGrid"]'
		} = options.input;

		try {
			const pageData = await page.evaluate(({ includeFormFields, includeTables, includeFilters, maxTableRows, formSelector, tableSelector }: any) => {
				interface FormField {
					label: string;
					type: string;
					id?: string;
					name?: string;
					placeholder?: string;
					required: boolean;
					options?: string[];
					value?: string;
				}

				interface FormSection {
					type: 'form_section';
					heading?: string;
					fields: FormField[];
				}

				interface DataTable {
					type: 'data_table';
					heading?: string;
					columns: string[];
					rowCount: number;
					sampleRows?: string[][];
				}

				interface FilterPanel {
					type: 'filter_panel';
					filters: Array<{
						label: string;
						type: string;
						options?: string[];
					}>;
				}

				interface PageContent {
					pageTitle: string;
					url: string;
					type: 'form' | 'table' | 'dashboard' | 'mixed';
					components: Array<FormSection | DataTable | FilterPanel>;
				}

				// Helper to get associated label for an input
				const getLabel = (input: Element): string => {
					// Check for aria-label
					const ariaLabel = input.getAttribute('aria-label');
					if (ariaLabel) return ariaLabel;
					
					// Check for associated label element
					const id = input.getAttribute('id');
					if (id) {
						const label = document.querySelector(`label[for="${id}"]`);
						if (label) return label.textContent?.trim() || '';
					}
					
					// Check for parent label
					const parentLabel = input.closest('label');
					if (parentLabel) {
						const labelText = parentLabel.textContent?.replace(input.textContent || '', '').trim();
						if (labelText) return labelText;
					}
					
					// Check for preceding label sibling
					const prevSibling = input.previousElementSibling;
					if (prevSibling?.tagName === 'LABEL') {
						return prevSibling.textContent?.trim() || '';
					}
					
					// Check for placeholder
					const placeholder = input.getAttribute('placeholder');
					if (placeholder) return placeholder;
					
					// Check for name attribute
					const name = input.getAttribute('name');
					if (name) return name.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
					
					return '';
				};

				// Helper to determine input type
				const getInputType = (input: Element): string => {
					const tagName = input.tagName.toLowerCase();
					if (tagName === 'select') return 'dropdown';
					if (tagName === 'textarea') return 'textarea';
					
					const type = input.getAttribute('type') || 'text';
					const typeMap: {[key: string]: string} = {
						'text': 'text',
						'email': 'email',
						'password': 'password',
						'number': 'number',
						'tel': 'phone',
						'date': 'date',
						'datetime-local': 'datetime',
						'time': 'time',
						'checkbox': 'checkbox',
						'radio': 'radio',
						'file': 'file',
						'search': 'search',
						'url': 'url'
					};
					return typeMap[type] || type;
				};

				// Extract form fields
				const extractForms = (): FormSection[] => {
					if (!includeFormFields) return [];
					
					const sections: FormSection[] = [];
					const forms = document.querySelectorAll(formSelector);
					
					// If no forms found, look for input fields directly
					const inputs: Element[] = forms.length > 0 
						? Array.from(forms).flatMap(f => Array.from(f.querySelectorAll('input, select, textarea')))
						: Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'));
					
					if (inputs.length === 0) return [];
					
					const fields: FormField[] = [];
					
					for (const input of inputs) {
						const inputEl = input as Element;
						const type = getInputType(inputEl);
						if (type === 'hidden') continue;
						
						const field: FormField = {
							label: getLabel(inputEl),
							type,
							id: inputEl.getAttribute('id') || undefined,
							name: inputEl.getAttribute('name') || undefined,
							placeholder: inputEl.getAttribute('placeholder') || undefined,
							required: inputEl.hasAttribute('required') || inputEl.getAttribute('aria-required') === 'true'
						};
						
						// Get options for select/dropdown
						if (inputEl.tagName.toLowerCase() === 'select') {
							const options = Array.from(inputEl.querySelectorAll('option'))
								.map((opt: Element) => (opt as HTMLElement).textContent?.trim() || '')
								.filter(text => text);
							if (options.length > 0) field.options = options;
						}
						
						// Get current value (not for password)
						if (type !== 'password') {
							const value = (inputEl as HTMLInputElement).value;
							if (value) field.value = value;
						}
						
						fields.push(field);
					}
					
					if (fields.length > 0) {
						// Try to find a heading for the form
						const formContainer = forms[0] || (inputs[0] as Element)?.closest('section, article, div[class*="card"], div[class*="panel"]');
						const heading = formContainer?.querySelector('h1, h2, h3, h4, legend')?.textContent?.trim();
						
						sections.push({
							type: 'form_section',
							heading: heading || undefined,
							fields
						});
					}
					
					return sections;
				};

				// Extract data tables
				const extractTables = (): DataTable[] => {
					if (!includeTables) return [];
					
					const tables: DataTable[] = [];
					const tableElements = document.querySelectorAll(tableSelector);
					
					for (const table of Array.from(tableElements)) {
						// Get columns from thead or first row
						const headerRow = table.querySelector('thead tr, tr:first-child');
						const columns = headerRow 
							? Array.from(headerRow.querySelectorAll('th, td')).map((cell) => (cell as HTMLElement).textContent?.trim() || '')
							: [];
						
						// Get row count
						const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
						const rowCount = rows.length;
						
						// Sample some rows
						const sampleRows: string[][] = [];
						for (let i = 0; i < Math.min(rowCount, maxTableRows); i++) {
							const row = rows[i];
							const cells = Array.from(row.querySelectorAll('td, th'))
								.map((cell) => (cell as HTMLElement).textContent?.trim().substring(0, 50) || '');
							sampleRows.push(cells);
						}
						
						// Try to find table heading
						const tableContainer = table.closest('section, article, div[class*="card"], div[class*="panel"]');
						const heading = tableContainer?.querySelector('h1, h2, h3, h4, caption')?.textContent?.trim();
						
						if (columns.length > 0 || rowCount > 0) {
							tables.push({
								type: 'data_table',
								heading: heading || undefined,
								columns: columns.filter(c => c),
								rowCount,
								sampleRows: sampleRows.length > 0 ? sampleRows : undefined
							});
						}
					}
					
					return tables;
				};

				// Extract filter panels
				const extractFilters = (): FilterPanel[] => {
					if (!includeFilters) return [];
					
					const filters: FilterPanel[] = [];
					
					// Look for common filter patterns
					const filterContainers = document.querySelectorAll(
						'[class*="filter"], [class*="Filter"], [role="search"], form[class*="search"], .search-form'
					);
					
					for (const container of Array.from(filterContainers)) {
						const filterItems: FilterPanel['filters'] = [];
						
						// Find checkboxes (often used in filters)
						const checkboxGroups = container.querySelectorAll('input[type="checkbox"]');
						if (checkboxGroups.length > 0) {
							const groupedByName = new Map<string, string[]>();
							for (const cb of Array.from(checkboxGroups)) {
								const label = getLabel(cb);
								const name = cb.getAttribute('name') || 'options';
								if (!groupedByName.has(name)) groupedByName.set(name, []);
								if (label) groupedByName.get(name)!.push(label);
							}
							
							for (const [name, options] of groupedByName) {
								filterItems.push({
									label: name.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim(),
									type: 'checkbox_group',
									options
								});
							}
						}
						
						// Find select dropdowns
						const selects = container.querySelectorAll('select');
						for (const select of Array.from(selects)) {
							const label = getLabel(select);
							const options = Array.from(select.querySelectorAll('option'))
								.map(opt => opt.textContent?.trim() || '')
								.filter(text => text);
							
							filterItems.push({
								label: label || select.getAttribute('name') || 'Filter',
								type: 'dropdown',
								options
							});
						}
						
						// Find text search inputs
						const searchInputs = container.querySelectorAll('input[type="search"], input[type="text"]');
						for (const input of Array.from(searchInputs)) {
							const label = getLabel(input);
							filterItems.push({
								label: label || 'Search',
								type: 'search'
							});
						}
						
						if (filterItems.length > 0) {
							filters.push({
								type: 'filter_panel',
								filters: filterItems
							});
						}
					}
					
					return filters;
				};

				// Determine page type
				const determinePageType = (forms: FormSection[], tables: DataTable[]): PageContent['type'] => {
					const hasForm = forms.length > 0 && forms.some(f => f.fields.length > 2);
					const hasTable = tables.length > 0 && tables.some(t => t.rowCount > 0);
					
					if (hasForm && hasTable) return 'mixed';
					if (hasForm) return 'form';
					if (hasTable) return 'table';
					return 'dashboard';
				};

				// Build the result
				const forms = extractForms();
				const tables = extractTables();
				const filters = extractFilters();
				
				const pageContent: PageContent = {
					pageTitle: document.title,
					url: window.location.href,
					type: determinePageType(forms, tables),
					components: [...forms, ...tables, ...filters]
				};
				
				return pageContent;
			}, { includeFormFields, includeTables, includeFilters, maxTableRows, formSelector, tableSelector });

			// Format output
			const output = JSON.stringify(pageData, null, 2);
			
			// Summary
			let summary = `## Page Content Scraping Complete\n\n`;
			summary += `- **Page Title:** ${pageData.pageTitle}\n`;
			summary += `- **URL:** ${pageData.url}\n`;
			summary += `- **Page Type:** ${pageData.type}\n`;
			summary += `- **Components Found:** ${pageData.components.length}\n\n`;
			
			// Component breakdown
			const formSections = pageData.components.filter((c: any) => c.type === 'form_section');
			const dataTables = pageData.components.filter((c: any) => c.type === 'data_table');
			const filterPanels = pageData.components.filter((c: any) => c.type === 'filter_panel');
			
			if (formSections.length > 0) {
				const totalFields = formSections.reduce((acc: number, f: any) => acc + f.fields.length, 0);
				summary += `### Forms: ${formSections.length} section(s), ${totalFields} field(s)\n`;
			}
			if (dataTables.length > 0) {
				const totalRows = dataTables.reduce((acc: number, t: any) => acc + t.rowCount, 0);
				summary += `### Tables: ${dataTables.length} table(s), ${totalRows} row(s)\n`;
			}
			if (filterPanels.length > 0) {
				const totalFilters = filterPanels.reduce((acc: number, f: any) => acc + f.filters.length, 0);
				summary += `### Filters: ${filterPanels.length} panel(s), ${totalFilters} filter(s)\n`;
			}
			
			summary += `\n### JSON Output\n\`\`\`json\n${output}\n\`\`\``;
			
			// Save to file if outputPath provided
			if (options.input.outputPath) {
				const fileUri = vscode.Uri.file(options.input.outputPath.trim());
				await vscode.workspace.fs.writeFile(fileUri, Buffer.from(output, 'utf8'));
				summary += `\n\n**Saved to:** ${options.input.outputPath}`;
			}
			
			return result([textPart(summary)]);
		} catch (error: any) {
			return result([textPart(`Error scraping page content: ${error.message}`)]);
		}
	}
}

// ----------------------------
// Wait For Element Tool
// ----------------------------
interface WaitForElementParams {
	element?: string;        // Human-readable description
	ref?: string;            // Element ref from snapshot
	text?: string;           // Find by visible text
	selector?: string;       // CSS or XPath selector
	toLeftOf?: string;       // Positional targeting
	toRightOf?: string;
	above?: string;
	below?: string;
	state: 'visible' | 'hidden' | 'attached' | 'detached';  // What to wait for
	timeout?: number;        // Max wait time in ms (default 30000)
}

export class WaitForElementTool implements vscode.LanguageModelTool<WaitForElementParams> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WaitForElementParams>) {
		const { ref, text, selector, state, element, toLeftOf, toRightOf, above, below } = options.input;
		let target = ref ? `ref=${ref}` : (text ? `text="${text}"` : (selector ? `selector="${selector}"` : element || 'element'));
		if (toLeftOf) target += ` to left of "${toLeftOf}"`;
		if (toRightOf) target += ` to right of "${toRightOf}"`;
		if (above) target += ` above "${above}"`;
		if (below) target += ` below "${below}"`;
		return {
			invocationMessage: `Wait for ${target} to become ${state}`,
			confirmationMessages: {
				title: 'Wait for element',
				message: new vscode.MarkdownString(`Wait for ${target} to become **${state}**`)
			}
		};
	}
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<WaitForElementParams>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const page = await BrowserManager.getPage();
		
		try {
			const { state, timeout = 30000, ref, text, selector, toLeftOf, toRightOf, above, below, element } = options.input;
			const startTime = Date.now();
			
			// Determine the locator based on provided targeting
			let locator: any;
			let targetDescription = element || '';
			
			if (ref) {
				// For ref, we need to get the element handle and find a selector
				// Since waitFor needs a locator, we'll try to re-find the element by its properties
				const elementHandle = BrowserManager.getElementByRef(ref);
				if (!elementHandle) {
					return result([textPart(`Error: ref="${ref}" not found. Use explorer_find or explorer_snapshot first.`)]);
				}
				// Get a unique selector for this element
				const uniqueSelector = await page.evaluate((el: any) => {
					if (el.id) return `#${el.id}`;
					if (el.name) return `[name="${el.name}"]`;
					// Build a path based selector
					const getPath = (elem: Element): string => {
						if (elem.id) return `#${elem.id}`;
						if (elem === document.body) return 'body';
						const parent = elem.parentElement;
						if (!parent) return elem.tagName.toLowerCase();
						const siblings = Array.from(parent.children);
						const index = siblings.indexOf(elem) + 1;
						return `${getPath(parent)} > ${elem.tagName.toLowerCase()}:nth-child(${index})`;
					};
					return getPath(el);
				}, elementHandle);
				locator = page.locator(uniqueSelector);
				targetDescription = targetDescription || `ref=${ref}`;
			} else if (selector) {
				// Use selector directly (supports CSS and xpath=)
				locator = getLocator(page, selector);
				targetDescription = targetDescription || `selector="${selector}"`;
			} else if (text) {
				// Find by text
				locator = page.getByText(text, { exact: false });
				targetDescription = targetDescription || `text="${text}"`;
			} else {
				return result([textPart('Error: Must provide ref, selector, or text to identify the element.')]);
			}
			
			// Note: For positional targeting with waitFor, we use the base locator
			// Positional filtering is more complex with waitFor, so we log a note
			if (toLeftOf) targetDescription += ` (toLeftOf="${toLeftOf}")`;
			if (toRightOf) targetDescription += ` (toRightOf="${toRightOf}")`;
			if (above) targetDescription += ` (above="${above}")`;
			if (below) targetDescription += ` (below="${below}")`;
			
			// Wait for the specified state
			try {
				await locator.first().waitFor({ state, timeout });
				const elapsed = Date.now() - startTime;
				return result([textPart(`✓ Element ${state} after ${elapsed}ms. Target: ${targetDescription}`)]);
			} catch (e: any) {
				return result([textPart(`✗ Timeout (${timeout}ms) waiting for element to become ${state}. Target: ${targetDescription}`)]);
			}
		} catch (error: any) {
			return result([textPart(`Error waiting for element: ${error.message}`)]);
		}
	}
}

