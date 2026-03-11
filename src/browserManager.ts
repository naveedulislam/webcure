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
import { chromium, Browser, BrowserContext, Page, LaunchOptions, Dialog, Request, Response, ElementHandle } from 'playwright-core';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface DialogInfo {
	type: string;
	message: string;
	defaultValue: string;
	handled: boolean;
	response?: 'accepted' | 'dismissed';
}

class BrowserManagerImpl {
	private browser: Browser | undefined;
	private context: BrowserContext | undefined;
	private page: Page | undefined;
	private consoleBuffer: { type: string; text: string }[] = [];
	private networkBuffer: { url: string; method?: string; status?: number }[] = [];
	private lastDialogInfo: DialogInfo | undefined;
	private nextDialogAction: { accept: boolean; promptText?: string } | undefined;
	private lastDownloadPath: string | undefined;

	// Element ref tracking for snapshot-based interactions
	private elementRefs = new Map<string, ElementHandle>();
	private refCounter = 0;

	/**
	 * Returns the existing page if it's open, or undefined.
	 * Does NOT create a new browser/page.
	 */
	getExistingPage(): Page | undefined {
		if (this.page && !this.page.isClosed()) {
			return this.page;
		}
		return undefined;
	}

	async getPage(): Promise<Page> {
		if (this.page && !this.page.isClosed()) {
			return this.page;
		}
		const channel = process.env.WEBEXPLORER_BROWSER || 'chrome'; // 'chrome' | 'msedge' | 'chromium'
		const launchOptions: LaunchOptions = {
			channel: channel === 'chromium' ? undefined : (channel as any),
			headless: false,
			args: [
				'--no-first-run',
				'--no-default-browser-check'
			]
		};
		this.browser = await chromium.launch(launchOptions);
		this.context = await this.browser.newContext({
			viewport: { width: 1280, height: 800 },
			acceptDownloads: true
		});
		this.page = await this.context.newPage();
		this.wirePageEvents(this.page);
		return this.page;
	}

	private wirePageEvents(page: Page) {
		this.consoleBuffer = [];
		this.networkBuffer = [];
		this.clearElementRefs(); // Clear element refs on new page
		page.on('console', msg => {
			try { this.consoleBuffer.push({ type: msg.type(), text: msg.text() }); } catch { }
		});
		page.on('dialog', async (dialog) => {
			this.lastDialogInfo = {
				type: dialog.type(),
				message: dialog.message(),
				defaultValue: dialog.defaultValue(),
				handled: false,
			};
			// Auto-handle the dialog to prevent Playwright from blocking
			const action = this.nextDialogAction;
			this.nextDialogAction = undefined;
			if (action) {
				if (action.accept) {
					await dialog.accept(action.promptText);
					this.lastDialogInfo.response = 'accepted';
				} else {
					await dialog.dismiss();
					this.lastDialogInfo.response = 'dismissed';
				}
			} else {
				// Default: accept alerts, dismiss confirms/prompts
				if (dialog.type() === 'alert') {
					await dialog.accept();
					this.lastDialogInfo.response = 'accepted';
				} else {
					await dialog.dismiss();
					this.lastDialogInfo.response = 'dismissed';
				}
			}
			this.lastDialogInfo.handled = true;
		});
		page.on('request', (req: Request) => {
			try { this.networkBuffer.push({ url: req.url(), method: req.method() }); } catch { }
		});
		page.on('response', (res: Response) => {
			try {
				// attach status to the last matching request entry
				const url = res.url();
				for (let i = this.networkBuffer.length - 1; i >= 0; i--) {
					if (!this.networkBuffer[i].status && this.networkBuffer[i].url === url) {
						this.networkBuffer[i].status = res.status();
						break;
					}
				}
			} catch { }
		});
		// Handle downloads
		page.on('download', async (download) => {
			try {
				const suggestedFilename = download.suggestedFilename();
				const downloadsPath = path.join(os.homedir(), 'Downloads', suggestedFilename);
				await download.saveAs(downloadsPath);
				this.lastDownloadPath = downloadsPath;
			} catch (error) {
				// Fallback to default behavior if custom path fails
				const defaultPath = await download.path();
				if (defaultPath) {
					this.lastDownloadPath = defaultPath;
				}
			}
		});
	}

	getConsoleMessages(onlyErrors?: boolean) {
		return this.consoleBuffer.filter(m => (onlyErrors ? m.type === 'error' : true));
	}

	getNetworkRequests() {
		return this.networkBuffer.slice();
	}

	/**
	 * Get info about the last dialog that appeared.
	 */
	getLastDialogInfo(): DialogInfo | undefined {
		return this.lastDialogInfo;
	}

	/**
	 * Consume and clear the last dialog info.
	 */
	pickDialogInfo(): DialogInfo | undefined {
		const d = this.lastDialogInfo;
		this.lastDialogInfo = undefined;
		return d;
	}

	/**
	 * Pre-configure how the next dialog should be handled.
	 * Call this BEFORE triggering an action that opens a dialog.
	 */
	setNextDialogAction(accept: boolean, promptText?: string): void {
		this.nextDialogAction = { accept, promptText };
	}

	getLastDownloadPath(): string | undefined {
		const path = this.lastDownloadPath;
		this.lastDownloadPath = undefined;
		return path;
	}

	getContext(): BrowserContext | undefined { return this.context; }

	async listTabs(): Promise<{ index: number; url: string; title: string }[]> {
		const ctx = this.context ?? (await this.getPage()).context();
		const pages = ctx.pages();
		const list: { index: number; url: string; title: string }[] = [];
		for (let i = 0; i < pages.length; i++) {
			const p = pages[i];
			list.push({ index: i + 1, url: p.url(), title: await p.title().catch(() => '') });
		}
		return list;
	}

	async newTab() {
		const ctx = this.context ?? (await this.getPage()).context();
		const p = await ctx.newPage();
		this.page = p;
		this.wirePageEvents(p);
		return p;
	}

	async selectTab(index: number) {
		const ctx = this.context ?? (await this.getPage()).context();
		const pages = ctx.pages();
		const i = Math.max(0, Math.min(index - 1, pages.length - 1));
		this.page = pages[i];
		return this.page;
	}

	async ensureViewport(width?: number, height?: number) {
		const page = await this.getPage();
		if (width && height) {
			await page.setViewportSize({ width, height });
		}
	}

	// Element ref management for snapshot-based interactions
	registerElement(handle: ElementHandle): string {
		this.refCounter++;
		const ref = `e${this.refCounter}`;
		this.elementRefs.set(ref, handle);
		return ref;
	}

	getElementByRef(ref: string): ElementHandle | undefined {
		return this.elementRefs.get(ref);
	}

	isElementRegistered(handle: ElementHandle): boolean {
		return Array.from(this.elementRefs.values()).some(
			registeredHandle => registeredHandle === handle
		);
	}

	clearElementRefs() {
		this.elementRefs.clear();
		this.refCounter = 0;
	}

	async dispose() {
		try {
			await this.page?.close();
		} catch { }
		try {
			await this.context?.close();
		} catch { }
		try {
			await this.browser?.close();
		} catch { }
		this.page = undefined;
		this.context = undefined;
		this.browser = undefined;
	}
}

export const BrowserManager = new BrowserManagerImpl();
