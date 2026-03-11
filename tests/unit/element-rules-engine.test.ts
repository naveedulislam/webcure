/**
 * WebCure — HTML Element Rules Engine — Comprehensive Tests
 *
 * Tests the engine by injecting it into a real Chromium browser page using
 * playwright-core + cached Playwright Chromium binaries (no elevated rights
 * needed — they live in ~/Library/Caches/ms-playwright/).
 *
 * Run with:
 *   npx tsx tests/unit/element-rules-engine.test.ts
 *
 * Coverage:
 *   §1  Element classification (W3C roles → semantic categories)
 *   §2  Interactive element resolution (deep-nested targets)
 *   §3  Accessible name computation (labelledby, label-for, aria-label, …)
 *   §4  Context resolution (dropdowns, menus, dialogs, portals)
 *   §5  Locator generation (testId, id, aria, text, css, xpath, name)
 *   §6  Input value extraction (text, password, checkbox, select, contenteditable)
 *   §7  Label extraction (table cells, previous siblings, text nodes)
 *   §8  Action descriptions (buttons, links, menu items, toggles, typing)
 *   §9  inspectElement full integration
 *  §10  Portal-based component patterns (Radix, Headless UI)
 *  §11  Edge cases & robustness
 */

import { chromium } from 'playwright-core';
import { getEngineScript } from '../../src/recorder/element-rules-engine';
import * as path from 'path';
import * as fs from 'fs';

// ─── Test Harness ──────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
const failures: string[] = [];
const sectionResults: Map<string, { pass: number; fail: number }> = new Map();
let currentSection = '';

function section(name: string) {
    currentSection = name;
    sectionResults.set(name, { pass: 0, fail: 0 });
    console.log(`\n  \x1b[1m${name}\x1b[0m`);
}

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual: any, expected: any, label: string) {
    if (actual !== expected) {
        throw new Error(`${label}: expected "${expected}", got "${actual}"`);
    }
}

function assertIncludes(haystack: string, needle: string, label: string) {
    if (!haystack.includes(needle)) {
        throw new Error(`${label}: expected "${haystack}" to include "${needle}"`);
    }
}

function assertArrayIncludes(arr: any[], value: any, label: string) {
    if (!arr.includes(value)) {
        throw new Error(`${label}: expected array to include "${value}", got [${arr.join(', ')}]`);
    }
}

async function it(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        passCount++;
        sectionResults.get(currentSection)!.pass++;
        console.log(`    \x1b[32m✓\x1b[0m ${name}`);
    } catch (err: any) {
        failCount++;
        sectionResults.get(currentSection)!.fail++;
        failures.push(`[${currentSection}] ${name}: ${err.message}`);
        console.log(`    \x1b[31m✗\x1b[0m ${name}`);
        console.log(`      \x1b[31m${err.message}\x1b[0m`);
    }
}

// ─── Browser Setup ─────────────────────────────────────────────────────────────

function findChromiumPath(): string {
    const cacheDir = path.join(process.env.HOME || '~', 'Library', 'Caches', 'ms-playwright');
    if (fs.existsSync(cacheDir)) {
        const dirs = fs.readdirSync(cacheDir).filter(d => d.startsWith('chromium-')).sort().reverse();
        for (const dir of dirs) {
            const candidates = [
                path.join(cacheDir, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                path.join(cacheDir, dir, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                path.join(cacheDir, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
            ];
            for (const c of candidates) {
                if (fs.existsSync(c)) return c;
            }
        }
    }
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(systemChrome)) return systemChrome;
    throw new Error('No Chromium/Chrome binary found. Run: npx playwright install chromium');
}

async function main() {
    console.log('\n\x1b[1m══════════════════════════════════════════════════════════════\x1b[0m');
    console.log('\x1b[1m  WebCure — HTML Element Rules Engine Tests\x1b[0m');
    console.log('\x1b[1m══════════════════════════════════════════════════════════════\x1b[0m');

    const executablePath = findChromiumPath();
    console.log(`  Browser: ${executablePath}`);

    const browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Inject the engine after every setContent (more reliable than addInitScript
    // for repeated setContent calls in tests)
    const engineScript = getEngineScript();

    async function setHTML(html: string) {
        await page.setContent('<!DOCTYPE html><html><body>' + html + '</body></html>', { waitUntil: 'domcontentloaded' });
        await page.evaluate(engineScript);
    }

    async function engineCall(fn: string, selector: string, ...args: any[]) {
        return page.evaluate(({ fn, selector, args }) => {
            const el = document.querySelector(selector);
            return (window as any).__webcure[fn](el, ...args);
        }, { fn, selector, args });
    }

    async function engineCallRaw(fn: string, ...args: any[]) {
        return page.evaluate(({ fn, args }) => {
            return (window as any).__webcure[fn](...args);
        }, { fn, args });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // §1  ELEMENT CLASSIFICATION
    // ═══════════════════════════════════════════════════════════════════════════

    section('§1 Element Classification — Implicit HTML-AAM Roles');

    await it('button → role "button", category "actionable"', async () => {
        await setHTML('<button id="t">Save</button>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'button', 'role');
        assertEqual(cat, 'actionable', 'category');
    });

    await it('a[href] → role "link", category "actionable"', async () => {
        await setHTML('<a href="/page" id="t">Go</a>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'link', 'role');
        assertEqual(cat, 'actionable', 'category');
    });

    await it('a (no href) → role null, category "generic"', async () => {
        await setHTML('<a id="t">Plain</a>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, null, 'role');
        assertEqual(cat, 'generic', 'category');
    });

    await it('input[type=text] → role "textbox", category "input"', async () => {
        await setHTML('<input type="text" id="t">');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'textbox', 'role');
        assertEqual(cat, 'input', 'category');
    });

    await it('input (no type) → role "textbox"', async () => {
        await setHTML('<input id="t">');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'textbox', 'role');
    });

    await it('input[type=checkbox] → role "checkbox", category "toggle"', async () => {
        await setHTML('<input type="checkbox" id="t">');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'checkbox', 'role');
        assertEqual(cat, 'toggle', 'category');
    });

    await it('input[type=radio] → role "radio", category "toggle"', async () => {
        await setHTML('<input type="radio" id="t">');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'radio', 'role');
        assertEqual(cat, 'toggle', 'category');
    });

    await it('input[type=submit] → role "button", category "actionable"', async () => {
        await setHTML('<input type="submit" value="Go" id="t">');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'button', 'role');
        assertEqual(cat, 'actionable', 'category');
    });

    await it('input[type=search] → role "searchbox"', async () => {
        await setHTML('<input type="search" id="t">');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'searchbox', 'role');
    });

    await it('input[type=number] → role "spinbutton"', async () => {
        await setHTML('<input type="number" id="t">');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'spinbutton', 'role');
    });

    await it('textarea → role "textbox"', async () => {
        await setHTML('<textarea id="t"></textarea>');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'textbox', 'role');
    });

    await it('select → role "combobox", category "select"', async () => {
        await setHTML('<select id="t"><option>A</option></select>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'combobox', 'role');
        assertEqual(cat, 'select', 'category');
    });

    await it('select[multiple] → role "listbox"', async () => {
        await setHTML('<select multiple id="t"><option>A</option></select>');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'listbox', 'role');
    });

    await it('option → role "option", category "option"', async () => {
        await setHTML('<select><option id="t">A</option></select>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'option', 'role');
        assertEqual(cat, 'option', 'category');
    });

    await it('nav → role "navigation"', async () => {
        await setHTML('<nav id="t">Menu</nav>');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'navigation', 'role');
    });

    await it('h1–h6 → role "heading"', async () => {
        for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
            await setHTML('<' + tag + ' id="t">Title</' + tag + '>');
            const role = await engineCall('resolveRole', '#t');
            assertEqual(role, 'heading', tag + ' role');
        }
    });

    await it('progress → role "progressbar"', async () => {
        await setHTML('<progress id="t" value="50" max="100"></progress>');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'progressbar', 'role');
    });

    await it('dialog → role "dialog", category "container"', async () => {
        await setHTML('<dialog id="t" open>Hello</dialog>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'dialog', 'role');
        assertEqual(cat, 'container', 'category');
    });

    await it('summary → role "button"', async () => {
        await setHTML('<details><summary id="t">More</summary>Details</details>');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'button', 'role');
    });

    await it('div (no role) → null, category "generic"', async () => {
        await setHTML('<div id="t">Text</div>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, null, 'role');
        assertEqual(cat, 'generic', 'category');
    });

    section('§1b Element Classification — Explicit ARIA Roles');

    await it('div[role="button"] → "button", "actionable"', async () => {
        await setHTML('<div role="button" id="t">Click me</div>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'button', 'role');
        assertEqual(cat, 'actionable', 'category');
    });

    await it('span[role="menuitem"] → "menuitem", "actionable"', async () => {
        await setHTML('<span role="menuitem" id="t">Edit</span>');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'menuitem', 'role');
    });

    await it('div[role="switch"] → "switch", "toggle"', async () => {
        await setHTML('<div role="switch" aria-checked="true" id="t">Dark Mode</div>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'switch', 'role');
        assertEqual(cat, 'toggle', 'category');
    });

    await it('div[role="combobox"] → "combobox", "select"', async () => {
        await setHTML('<div role="combobox" id="t">Choose...</div>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'combobox', 'role');
        assertEqual(cat, 'select', 'category');
    });

    await it('div[role="treeitem"] → "treeitem", "option"', async () => {
        await setHTML('<div role="treeitem" id="t">Folder</div>');
        const role = await engineCall('resolveRole', '#t');
        const cat = await engineCallRaw('classifyRole', role);
        assertEqual(role, 'treeitem', 'role');
        assertEqual(cat, 'option', 'category');
    });

    await it('explicit role overrides implicit', async () => {
        await setHTML('<div role="link" id="t">A link</div>');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'link', 'role');
    });

    await it('multiple-role attribute uses first token', async () => {
        await setHTML('<div role="tab presentation" id="t">Tab</div>');
        const role = await engineCall('resolveRole', '#t');
        assertEqual(role, 'tab', 'role');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §2  INTERACTIVE ELEMENT RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════════

    section('§2 Interactive Element Resolution');

    await it('resolves a <button> directly', async () => {
        await setHTML('<button id="btn">OK</button>');
        const tag = await page.evaluate(() => {
            const el = document.querySelector('#btn')!;
            return (window as any).__webcure.resolveInteractiveElement(el)?.tagName?.toLowerCase();
        });
        assertEqual(tag, 'button', 'resolved tag');
    });

    await it('resolves span inside button → button', async () => {
        await setHTML('<button id="btn"><span id="inner">Icon</span></button>');
        const id = await page.evaluate(() => {
            const span = document.querySelector('#inner')!;
            return (window as any).__webcure.resolveInteractiveElement(span)?.id;
        });
        assertEqual(id, 'btn', 'resolved to button');
    });

    await it('resolves svg inside a[href] → link', async () => {
        await setHTML('<a href="/home" id="link"><svg id="icon"><circle r="5"/></svg></a>');
        const id = await page.evaluate(() => {
            const svg = document.querySelector('#icon')!;
            return (window as any).__webcure.resolveInteractiveElement(svg)?.id;
        });
        assertEqual(id, 'link', 'resolved to link');
    });

    await it('resolves deeply nested span in [role="option"] → option', async () => {
        await setHTML('<div role="listbox"><div role="option" id="opt1"><div><span id="deep">Text</span></div></div></div>');
        const id = await page.evaluate(() => {
            const span = document.querySelector('#deep')!;
            return (window as any).__webcure.resolveInteractiveElement(span)?.id;
        });
        assertEqual(id, 'opt1', 'resolved to option');
    });

    await it('resolves element with data-slot framework hint', async () => {
        await setHTML('<div data-slot="dropdown-menu-trigger" id="trigger"><span id="s">+New</span></div>');
        const id = await page.evaluate(() => {
            const span = document.querySelector('#s')!;
            return (window as any).__webcure.resolveInteractiveElement(span)?.id;
        });
        assertEqual(id, 'trigger', 'resolved to data-slot element');
    });

    await it('resolves element with tabindex="0"', async () => {
        await setHTML('<div tabindex="0" id="custom"><span id="s">Item</span></div>');
        const id = await page.evaluate(() => {
            const span = document.querySelector('#s')!;
            return (window as any).__webcure.resolveInteractiveElement(span)?.id;
        });
        assertEqual(id, 'custom', 'resolved to tabindex element');
    });

    await it('returns null for document.body', async () => {
        await setHTML('<div>Hello</div>');
        const result = await page.evaluate(() => {
            return (window as any).__webcure.resolveInteractiveElement(document.body);
        });
        assertEqual(result, null, 'body returns null');
    });

    await it('returns original target for plain div', async () => {
        await setHTML('<section><div id="plain">Just text</div></section>');
        const id = await page.evaluate(() => {
            const div = document.querySelector('#plain')!;
            return (window as any).__webcure.resolveInteractiveElement(div)?.id;
        });
        assertEqual(id, 'plain', 'fallback to original target');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §3  ACCESSIBLE NAME COMPUTATION
    // ═══════════════════════════════════════════════════════════════════════════

    section('§3 Accessible Name Computation');

    await it('aria-labelledby (single ID)', async () => {
        await setHTML('<span id="lbl">Username</span><input aria-labelledby="lbl" id="t">');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'Username', 'acc name');
    });

    await it('aria-labelledby (multiple IDs)', async () => {
        await setHTML('<span id="a">First</span><span id="b">Last</span><input aria-labelledby="a b" id="t">');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'First Last', 'acc name');
    });

    await it('aria-label', async () => {
        await setHTML('<button aria-label="Close dialog" id="t">X</button>');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'Close dialog', 'acc name');
    });

    await it('label[for] association', async () => {
        await setHTML('<label for="email">Email Address</label><input id="email">');
        const name = await engineCall('getAccessibleName', '#email');
        assertEqual(name, 'Email Address', 'acc name');
    });

    await it('enclosing <label>', async () => {
        await setHTML('<label>Phone <input id="t"></label>');
        const name = await engineCall('getAccessibleName', '#t');
        assertIncludes(name as string, 'Phone', 'acc name');
    });

    await it('title attribute', async () => {
        await setHTML('<button title="Save document" id="t"><svg></svg></button>');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'Save document', 'acc name');
    });

    await it('placeholder', async () => {
        await setHTML('<input placeholder="Search..." id="t">');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'Search...', 'acc name');
    });

    await it('alt text (img)', async () => {
        await setHTML('<img alt="Company logo" id="t">');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'Company logo', 'acc name');
    });

    await it('input[type=submit] value', async () => {
        await setHTML('<input type="submit" value="Submit Form" id="t">');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'Submit Form', 'acc name');
    });

    await it('button text content', async () => {
        await setHTML('<button id="t">Save Changes</button>');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'Save Changes', 'acc name');
    });

    await it('priority: aria-labelledby > aria-label', async () => {
        await setHTML('<span id="lbl">From label</span><button aria-labelledby="lbl" aria-label="From aria" id="t">Text</button>');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'From label', 'priority');
    });

    await it('priority: aria-label > title', async () => {
        await setHTML('<button aria-label="From aria" title="From title" id="t">Text</button>');
        const name = await engineCall('getAccessibleName', '#t');
        assertEqual(name, 'From aria', 'priority');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §4  CONTEXT RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════════

    section('§4 Context Resolution — Dropdowns, Menus, Dialogs');

    await it('menu + aria-labelledby → resolves trigger', async () => {
        await setHTML('<button id="trigger">Actions</button><div role="menu" aria-labelledby="trigger"><div role="menuitem" id="item">Edit</div></div>');
        const ctx = await engineCall('resolveOwningContext', '#item');
        assertEqual((ctx as any).containerRole, 'menu', 'container role');
        assertEqual((ctx as any).triggerLabel, 'Actions', 'trigger label');
    });

    await it('listbox + aria-labelledby → resolves trigger', async () => {
        await setHTML('<button id="combo-trigger" aria-label="Select color">Blue</button><div role="listbox" aria-labelledby="combo-trigger"><div role="option" id="opt">Red</div></div>');
        const ctx = await engineCall('resolveOwningContext', '#opt');
        assertEqual((ctx as any).containerRole, 'listbox', 'container role');
        assertEqual((ctx as any).triggerLabel, 'Select color', 'trigger label');
    });

    await it('menu with aria-label (no trigger)', async () => {
        await setHTML('<div role="menu" aria-label="File operations"><div role="menuitem" id="item">Save</div></div>');
        const ctx = await engineCall('resolveOwningContext', '#item');
        assertEqual((ctx as any).containerRole, 'menu', 'container role');
        assertEqual((ctx as any).triggerLabel, 'File operations', 'trigger label');
    });

    await it('aria-controls reverse lookup', async () => {
        await setHTML('<button aria-controls="menu1" id="btn">Options</button><div role="menu" id="menu1"><div role="menuitem" id="item">Delete</div></div>');
        const ctx = await engineCall('resolveOwningContext', '#item');
        assertEqual((ctx as any).triggerLabel, 'Options', 'trigger from aria-controls');
    });

    await it('Radix portal → trigger via aria-controls', async () => {
        await setHTML('<button aria-controls="radix-content" id="trigger">+ New</button><div data-radix-popper-content-wrapper><div role="menu" id="radix-content"><div role="menuitem" id="item">Project</div></div></div>');
        const ctx = await engineCall('resolveOwningContext', '#item');
        assertIncludes((ctx as any).triggerLabel, 'New', 'Radix trigger');
    });

    await it('dialog container resolves', async () => {
        await setHTML('<button id="dlg-trigger">Open Settings</button><div role="dialog" aria-labelledby="dlg-trigger"><button id="inner-btn">Close</button></div>');
        const ctx = await engineCall('resolveOwningContext', '#inner-btn');
        assertEqual((ctx as any).containerRole, 'dialog', 'container role');
        assertEqual((ctx as any).triggerLabel, 'Open Settings', 'trigger label');
    });

    await it('no context for standalone element', async () => {
        await setHTML('<button id="t">Standalone</button>');
        const ctx = await engineCall('resolveOwningContext', '#t');
        assertEqual((ctx as any).containerRole, null, 'no container');
        assertEqual((ctx as any).triggerLabel, '', 'no trigger');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §5  LOCATOR GENERATION
    // ═══════════════════════════════════════════════════════════════════════════

    section('§5 Locator Generation — Multi-Strategy');

    await it('data-testid → highest confidence (1.0)', async () => {
        await setHTML('<button data-testid="save-btn" id="t">Save</button>');
        const locators = await engineCall('generateLocators', '#t') as any[];
        const testIdLoc = locators.find((l: any) => l.strategy === 'testId');
        assert(!!testIdLoc, 'testId locator exists');
        assertEqual(testIdLoc.confidence, 1.0, 'confidence');
    });

    await it('data-cy → recognized as testId', async () => {
        await setHTML('<input data-cy="email-input" id="t">');
        const locators = await engineCall('generateLocators', '#t') as any[];
        const testIdLoc = locators.find((l: any) => l.strategy === 'testId');
        assert(!!testIdLoc, 'testId locator exists');
        assertIncludes(testIdLoc.value, 'data-cy', 'uses data-cy');
    });

    await it('element with id → id locator (0.95)', async () => {
        await setHTML('<button id="submit-btn">Go</button>');
        const locators = await engineCall('generateLocators', '#submit-btn') as any[];
        const idLoc = locators.find((l: any) => l.strategy === 'id');
        assert(!!idLoc, 'id locator exists');
        assertEqual(idLoc.value, 'submit-btn', 'id value');
        assertEqual(idLoc.confidence, 0.95, 'confidence');
    });

    await it('button text → text locator', async () => {
        await setHTML('<button id="t">Add to Cart</button>');
        const locators = await engineCall('generateLocators', '#t') as any[];
        const txtLoc = locators.find((l: any) => l.strategy === 'text');
        assert(!!txtLoc, 'text locator exists');
        assertEqual(txtLoc.value, 'Add to Cart', 'text value');
    });

    await it('link text → linkText locator', async () => {
        await setHTML('<a href="/about" id="t">About Us</a>');
        const locators = await engineCall('generateLocators', '#t') as any[];
        const linkLoc = locators.find((l: any) => l.strategy === 'linkText');
        assert(!!linkLoc, 'linkText locator exists');
        assertEqual(linkLoc.value, 'About Us', 'link text');
    });

    await it('button with aria-label → aria locator', async () => {
        await setHTML('<button aria-label="Close" id="t">X</button>');
        const locators = await engineCall('generateLocators', '#t') as any[];
        const ariaLoc = locators.find((l: any) => l.strategy === 'aria');
        assert(!!ariaLoc, 'aria locator exists');
        assertIncludes(ariaLoc.value, 'button', 'includes role');
        assertIncludes(ariaLoc.value, 'Close', 'includes name');
    });

    await it('input with name → name locator', async () => {
        await setHTML('<input name="username" id="t">');
        const locators = await engineCall('generateLocators', '#t') as any[];
        const nameLoc = locators.find((l: any) => l.strategy === 'name');
        assert(!!nameLoc, 'name locator');
        assertEqual(nameLoc.value, 'username', 'name value');
    });

    await it('always includes css and xpath', async () => {
        await setHTML('<button id="t">OK</button>');
        const locators = await engineCall('generateLocators', '#t') as any[];
        const strategies = locators.map((l: any) => l.strategy);
        assertArrayIncludes(strategies, 'css', 'css present');
        assertArrayIncludes(strategies, 'xpath', 'xpath present');
    });

    await it('css selector uses #id shortcut', async () => {
        await setHTML('<button id="my-btn">OK</button>');
        const locators = await engineCall('generateLocators', '#my-btn') as any[];
        const cssLoc = locators.find((l: any) => l.strategy === 'css');
        assertEqual(cssLoc.value, '#my-btn', 'css id shortcut');
    });

    await it('xpath uses id shortcut', async () => {
        await setHTML('<button id="my-btn">OK</button>');
        const locators = await engineCall('generateLocators', '#my-btn') as any[];
        const xpLoc = locators.find((l: any) => l.strategy === 'xpath');
        assertEqual(xpLoc.value, '//*[@id="my-btn"]', 'xpath id');
    });

    await it('locators sorted by confidence descending', async () => {
        await setHTML('<button data-testid="btn" aria-label="Save" id="save-btn">Save</button>');
        const locators = await engineCall('generateLocators', '#save-btn') as any[];
        for (let i = 1; i < locators.length; i++) {
            assert(locators[i - 1].confidence >= locators[i].confidence,
                'locator[' + (i-1) + '] (' + locators[i-1].confidence + ') >= locator[' + i + '] (' + locators[i].confidence + ')');
        }
    });

    await it('element without id → css uses positional selector', async () => {
        await setHTML('<div><span>A</span><span id="target">B</span></div>');
        const css = await page.evaluate(() => {
            const spans = document.querySelectorAll('span');
            return (window as any).__webcure.generateLocators(spans[0]).find((l: any) => l.strategy === 'css')?.value;
        });
        assert(!!css, 'css locator generated');
        assert(!css.includes('#'), 'no id in css path');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §6  INPUT VALUE EXTRACTION
    // ═══════════════════════════════════════════════════════════════════════════

    section('§6 Input Value Extraction');

    await it('text input → returns value', async () => {
        await setHTML('<input type="text" value="hello" id="t">');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.value, 'hello', 'text value');
    });

    await it('password input → obscured', async () => {
        await setHTML('<input type="password" value="secret123" id="t">');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.value, '********', 'password obscured');
    });

    await it('checkbox checked', async () => {
        await setHTML('<input type="checkbox" checked id="t">');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.value, 'checked', 'checkbox checked');
    });

    await it('checkbox unchecked', async () => {
        await setHTML('<input type="checkbox" id="t">');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.value, 'unchecked', 'checkbox unchecked');
    });

    await it('select → selected option text', async () => {
        await setHTML('<select id="t"><option>Apple</option><option selected>Banana</option></select>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.value, 'Banana', 'select value');
    });

    await it('textarea → returns value', async () => {
        await setHTML('<textarea id="t"></textarea>');
        await page.evaluate(() => { (document.querySelector('#t') as HTMLTextAreaElement).value = 'Some notes'; });
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.value, 'Some notes', 'textarea value');
    });

    await it('contenteditable → text content', async () => {
        await setHTML('<div contenteditable="true" id="t">Editable text</div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.value, 'Editable text', 'contenteditable value');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §7  LABEL EXTRACTION
    // ═══════════════════════════════════════════════════════════════════════════

    section('§7 Label Extraction — Form Field Heuristics');

    await it('label[for] → label text', async () => {
        await setHTML('<label for="user">Username</label><input id="user">');
        const label = await engineCall('extractLabel', '#user');
        assertEqual(label, 'Username', 'label');
    });

    await it('enclosing label', async () => {
        await setHTML('<label>Email: <input id="t"></label>');
        const label = await engineCall('extractLabel', '#t');
        assertIncludes(label as string, 'Email', 'label');
    });

    await it('table cell heuristic (previous td)', async () => {
        await setHTML('<table><tr><td>Company Name</td><td><input id="t"></td></tr></table>');
        const label = await engineCall('extractLabel', '#t');
        assertEqual(label, 'Company Name', 'table cell label');
    });

    await it('previous sibling span', async () => {
        await setHTML('<div><span>Amount</span><input id="t"></div>');
        const label = await engineCall('extractLabel', '#t');
        assertEqual(label, 'Amount', 'sibling label');
    });

    await it('previous sibling strong tag strips colon', async () => {
        await setHTML('<div><strong>Notes:</strong><textarea id="t"></textarea></div>');
        const label = await engineCall('extractLabel', '#t');
        assertEqual(label, 'Notes', 'stripped colon');
    });

    await it('previous text node', async () => {
        await setHTML('<div>Quantity: <input id="t"></div>');
        const label = await engineCall('extractLabel', '#t');
        assertEqual(label, 'Quantity', 'text node label');
    });

    await it('aria-label on button', async () => {
        await setHTML('<button aria-label="Submit form" id="t">→</button>');
        const label = await engineCall('extractLabel', '#t');
        assertEqual(label, 'Submit form', 'aria-label');
    });

    await it('button text as label', async () => {
        await setHTML('<button id="t">Save</button>');
        const label = await engineCall('extractLabel', '#t');
        assertEqual(label, 'Save', 'button text');
    });

    await it('falls back to name attr', async () => {
        await setHTML('<input name="zip_code" type="hidden" id="t">');
        const label = await engineCall('extractLabel', '#t');
        assert(label === 'zip_code' || label === 't', 'name or id fallback: got ' + label);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §8  ACTION DESCRIPTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    section('§8 Action Descriptions');

    await it('button click', async () => {
        await setHTML('<button id="t">Save</button>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.description, "Clicked button 'Save'", 'desc');
    });

    await it('link click', async () => {
        await setHTML('<a href="/" id="t">Home</a>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.description, "Clicked link 'Home'", 'desc');
    });

    await it('menu item with trigger', async () => {
        await setHTML('<button id="trigger">Actions</button><div role="menu" aria-labelledby="trigger"><div role="menuitem" id="t">Edit</div></div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.description, "Selected 'Edit' from 'Actions' dropdown", 'desc');
    });

    await it('option in listbox with trigger', async () => {
        await setHTML('<button id="trigger" aria-label="Color">Blue</button><div role="listbox" aria-labelledby="trigger"><div role="option" id="t">Red</div></div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.description, "Selected 'Red' from 'Color' list", 'desc');
    });

    await it('menu item without trigger', async () => {
        await setHTML('<div role="menu"><div role="menuitem" id="t">Delete</div></div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.description, "Selected menu item 'Delete'", 'desc');
    });

    await it('checkbox toggle', async () => {
        await setHTML('<label><input type="checkbox" id="t"> Remember me</label>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertIncludes(info.description, 'Toggled', 'toggle');
        assertIncludes(info.description, 'checkbox', 'kind');
    });

    await it('switch toggle', async () => {
        await setHTML('<div role="switch" aria-label="Dark Mode" id="t">On</div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertIncludes(info.description, 'switch', 'kind');
        assertIncludes(info.description, 'Dark Mode', 'label');
    });

    await it('combobox click', async () => {
        await setHTML('<div role="combobox" aria-label="Font Size" id="t">12</div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertIncludes(info.description, 'combobox', 'role');
        assertIncludes(info.description, 'Font Size', 'label');
    });

    await it('type event', async () => {
        await setHTML('<input placeholder="Search" id="t">');
        const info = await engineCall('inspectElement', '#t', 'type', { value: 'hello' }) as any;
        assertEqual(info.description, "Typed 'hello' into 'Search'", 'desc');
    });

    await it('keydown event', async () => {
        await setHTML('<label for="u">Username</label><input id="u">');
        const info = await engineCall('inspectElement', '#u', 'keydown', { key: 'Enter' }) as any;
        assertEqual(info.description, "Pressed Enter on 'Username'", 'desc');
    });

    await it('div[role="button"] click', async () => {
        await setHTML('<div role="button" id="t">Custom Button</div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertIncludes(info.description, 'button', 'custom button');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §9  inspectElement — FULL INTEGRATION
    // ═══════════════════════════════════════════════════════════════════════════

    section('§9 inspectElement — Full Integration');

    await it('returns all expected fields', async () => {
        await setHTML('<button data-testid="save" aria-label="Save doc" id="save-btn">Save</button>');
        const info = await engineCall('inspectElement', '#save-btn', 'click') as any;
        assertEqual(info.tagName, 'BUTTON', 'tagName');
        assertEqual(info.role, 'button', 'role');
        assertEqual(info.category, 'actionable', 'category');
        assert(!!info.label, 'has label');
        assert(!!info.accessibleName, 'has accessible name');
        assert(info.locators.length >= 4, 'has multiple locators');
        assert(!!info.description, 'has description');
        assertEqual(info.id, 'save-btn', 'id');
        assertEqual(info.cssSelector, '#save-btn', 'cssSelector');
        assert(!!info.xpath, 'has xpath');
    });

    await it('legacy compatibility fields', async () => {
        await setHTML('<label for="name">Full Name</label><input id="name" value="John">');
        const info = await engineCall('inspectElement', '#name', 'type', { value: 'John' }) as any;
        assertEqual(info.labelText, 'Full Name', 'labelText compat');
        assert(info.cssSelector !== '', 'cssSelector compat');
        assert(info.xpath !== '', 'xpath compat');
    });

    await it('context fields for menu items', async () => {
        await setHTML('<button id="trigger">File</button><div role="menu" aria-labelledby="trigger"><div role="menuitem" id="t">New</div></div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.context.containerRole, 'menu', 'context.containerRole');
        assertEqual(info.context.triggerLabel, 'File', 'context.triggerLabel');
        assertEqual(info.menuTriggerLabel, 'File', 'legacy menuTriggerLabel');
    });

    await it('input[type=submit] has buttonText', async () => {
        await setHTML('<input type="submit" value="Login" id="t">');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assertEqual(info.buttonText, 'Login', 'buttonText compat');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §10  PORTAL-BASED COMPONENT PATTERNS
    // ═══════════════════════════════════════════════════════════════════════════

    section('§10 Portal-Based Component Patterns');

    await it('Radix DropdownMenu: trigger + portal', async () => {
        await setHTML('<button id="radix-trigger" aria-haspopup="menu" aria-controls="radix-menu">Actions</button><div data-radix-popper-content-wrapper><div role="menu" id="radix-menu" aria-labelledby="radix-trigger"><div role="menuitem" id="item1">Edit</div><div role="menuitem" id="item2">Delete</div></div></div>');
        const info1 = await engineCall('inspectElement', '#item1', 'click') as any;
        assertEqual(info1.description, "Selected 'Edit' from 'Actions' dropdown", 'Radix menuitem');
        const info2 = await engineCall('inspectElement', '#item2', 'click') as any;
        assertIncludes(info2.description, 'Delete', 'second item');
        assertIncludes(info2.description, 'Actions', 'trigger context');
    });

    await it('Radix Select: nested spans in options', async () => {
        await setHTML('<button role="combobox" aria-controls="radix-listbox" id="select-trigger" aria-label="Color">Blue</button><div data-radix-popper-content-wrapper><div role="listbox" id="radix-listbox" aria-labelledby="select-trigger"><div role="option" id="opt-red"><span id="inner-span">Red</span></div></div></div>');
        const resolved = await page.evaluate(() => {
            const span = document.querySelector('#inner-span')!;
            return (window as any).__webcure.resolveInteractiveElement(span)?.id;
        });
        assertEqual(resolved, 'opt-red', 'span resolves to option');
        const info = await engineCall('inspectElement', '#opt-red', 'click') as any;
        assertEqual(info.description, "Selected 'Red' from 'Color' list", 'Radix Select option');
    });

    await it('Headless UI Listbox pattern', async () => {
        await setHTML('<button id="headless-btn" aria-haspopup="listbox" aria-controls="headless-list">Choose</button><ul role="listbox" id="headless-list" aria-labelledby="headless-btn" data-headlessui-state="open"><li role="option" id="opt-a">Option A</li></ul>');
        const info = await engineCall('inspectElement', '#opt-a', 'click') as any;
        assertIncludes(info.description, 'Option A', 'option label');
        assertIncludes(info.description, 'Choose', 'trigger label');
    });

    await it('MUI-style Menu (pure ARIA)', async () => {
        await setHTML('<button id="mui-btn" aria-controls="mui-menu" aria-haspopup="true">More</button><div role="menu" id="mui-menu" aria-labelledby="mui-btn"><li role="menuitem" id="mui-item">Settings</li></div>');
        const info = await engineCall('inspectElement', '#mui-item', 'click') as any;
        assertEqual(info.description, "Selected 'Settings' from 'More' dropdown", 'MUI menu');
    });

    await it('Nested SVG/spans inside menuitem resolve', async () => {
        await setHTML('<button id="trigger">Menu</button><div role="menu" aria-labelledby="trigger"><div role="menuitem" id="mi"><svg id="icon"><path d="M0 0"/></svg><span id="label-span">Edit Profile</span></div></div>');
        const fromSvg = await page.evaluate(() => {
            return (window as any).__webcure.resolveInteractiveElement(document.querySelector('#icon'))?.id;
        });
        assertEqual(fromSvg, 'mi', 'SVG resolves to menuitem');
        const fromSpan = await page.evaluate(() => {
            return (window as any).__webcure.resolveInteractiveElement(document.querySelector('#label-span'))?.id;
        });
        assertEqual(fromSpan, 'mi', 'span resolves to menuitem');
    });

    await it('Tab panels', async () => {
        await setHTML('<div role="tablist"><button role="tab" id="tab1" aria-selected="true">General</button><button role="tab" id="tab2">Advanced</button></div>');
        const info = await engineCall('inspectElement', '#tab2', 'click') as any;
        assertEqual(info.role, 'tab', 'tab role');
        assertEqual(info.category, 'navigation', 'nav category');
        assertIncludes(info.description, 'Advanced', 'tab label');
    });

    await it('Tree view items', async () => {
        await setHTML('<div role="tree" aria-label="File browser"><div role="treeitem" id="ti"><span id="ti-label">src/</span></div></div>');
        const resolved = await page.evaluate(() => {
            return (window as any).__webcure.resolveInteractiveElement(document.querySelector('#ti-label'))?.id;
        });
        assertEqual(resolved, 'ti', 'span resolves to treeitem');
    });

    await it('Radio group', async () => {
        await setHTML('<div role="radiogroup" aria-label="Shipping"><label><input type="radio" name="ship" id="r2" value="express"> Express</label></div>');
        const info = await engineCall('inspectElement', '#r2', 'click') as any;
        assertEqual(info.role, 'radio', 'radio role');
        assertEqual(info.category, 'toggle', 'toggle category');
        assertIncludes(info.description, 'radio', 'radio kind');
    });

    await it('menuitemcheckbox', async () => {
        await setHTML('<button id="view-btn">View</button><div role="menu" aria-labelledby="view-btn"><div role="menuitemcheckbox" aria-checked="true" id="mic">Show Toolbar</div></div>');
        const info = await engineCall('inspectElement', '#mic', 'click') as any;
        assertIncludes(info.description, 'Show Toolbar', 'item label');
        assertIncludes(info.description, 'View', 'trigger label');
    });

    await it('menuitemradio', async () => {
        await setHTML('<button id="sort-btn">Sort</button><div role="menu" aria-labelledby="sort-btn"><div role="menuitemradio" aria-checked="true" id="mir">By Name</div></div>');
        const info = await engineCall('inspectElement', '#mir', 'click') as any;
        assertIncludes(info.description, 'By Name', 'radio item');
        assertIncludes(info.description, 'Sort', 'trigger');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // §11  EDGE CASES
    // ═══════════════════════════════════════════════════════════════════════════

    section('§11 Edge Cases & Robustness');

    await it('very long text truncated', async () => {
        const longText = 'A'.repeat(300);
        await setHTML('<button id="t">' + longText + '</button>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assert(info.text.length <= 200, 'text truncated to 200');
        assert(info.description.length < 300, 'description truncated');
    });

    await it('element with no text handled gracefully', async () => {
        await setHTML('<div id="t"></div>');
        const info = await engineCall('inspectElement', '#t', 'click') as any;
        assert(info !== null, 'returns result');
        assert(info.description !== undefined, 'has description');
    });

    await it('null element → returns null', async () => {
        const result = await page.evaluate(() => {
            return (window as any).__webcure.inspectElement(null, 'click');
        });
        assertEqual(result, null, 'null for null input');
    });

    await it('special characters in id are CSS-escaped', async () => {
        await setHTML('<button id="my:btn.test">OK</button>');
        const locators = await page.evaluate(() => {
            const el = document.getElementById('my:btn.test')!;
            return (window as any).__webcure.generateLocators(el);
        }) as any[];
        const cssLoc = locators.find((l: any) => l.strategy === 'css');
        assert(!!cssLoc, 'css locator exists');
        assert(cssLoc.value.includes('my'), 'contains id');
    });

    await it('captured data survives element removal', async () => {
        await setHTML('<div role="menu" aria-label="Quick Actions"><div role="menuitem" id="ephemeral">Rename</div></div>');
        const info = await engineCall('inspectElement', '#ephemeral', 'click') as any;
        await page.evaluate(() => document.getElementById('ephemeral')?.remove());
        assertEqual(info.role, 'menuitem', 'captured role');
        assertIncludes(info.description, 'Rename', 'captured label');
    });

    await it('deeply nested (10 levels) resolves efficiently', async () => {
        await setHTML('<button id="deep-btn"><div><div><div><div><div><div><div><div><div><span id="very-deep">Click</span></div></div></div></div></div></div></div></div></div></button>');
        const start = Date.now();
        const resolved = await page.evaluate(() => {
            return (window as any).__webcure.resolveInteractiveElement(document.querySelector('#very-deep'))?.id;
        });
        const elapsed = Date.now() - start;
        assertEqual(resolved, 'deep-btn', 'resolved through 10 levels');
        assert(elapsed < 500, 'fast resolution: ' + elapsed + 'ms < 500ms');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // CLEANUP & SUMMARY
    // ═══════════════════════════════════════════════════════════════════════════

    await browser.close();

    console.log('\n\x1b[1m══════════════════════════════════════════════════════════════\x1b[0m');
    console.log('\x1b[1m  Results Summary\x1b[0m');
    console.log('\x1b[1m══════════════════════════════════════════════════════════════\x1b[0m');

    for (const [name, result] of sectionResults) {
        const status = result.fail === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        console.log('  ' + status + ' ' + name + ': ' + result.pass + ' passed, ' + result.fail + ' failed');
    }

    console.log('\n  \x1b[1mTotal: ' + passCount + ' passed, ' + failCount + ' failed\x1b[0m');

    if (failures.length > 0) {
        console.log('\n  \x1b[31mFailures:\x1b[0m');
        failures.forEach((f, i) => console.log('    ' + (i + 1) + '. ' + f));
    }

    console.log('');
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(2);
});
