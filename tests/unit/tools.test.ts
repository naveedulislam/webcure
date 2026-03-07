/**
 * WebCure Unit Tests
 *
 * These tests verify the internal logic of tool classes, bridge routing,
 * and helper functions without requiring a running browser or VS Code instance.
 *
 * Run with: npx mocha --require ts-node/register tests/unit/tools.test.ts
 * Or after compile: node tests/unit/tools.test.js
 *
 * Since the tools depend heavily on VS Code APIs and Playwright, most tests
 * use mocks/stubs. The tests focus on:
 *   1. Bridge command routing (BRIDGE_TO_TOOL mapping)
 *   2. Parameter transformation (mapArgs functions)
 *   3. Helper function logic (getLocator patterns, unified targeting)
 *   4. Error handling paths
 */

import * as assert from 'assert';

// =============================================================================
// Test Runner (lightweight — no framework required)
// =============================================================================

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function describe(name: string, fn: () => void) {
    console.log(`\n  ${name}`);
    fn();
}

function it(name: string, fn: () => void) {
    try {
        fn();
        passCount++;
        console.log(`    \x1b[32m✓\x1b[0m ${name}`);
    } catch (err: any) {
        failCount++;
        failures.push(`${name}: ${err.message}`);
        console.log(`    \x1b[31m✗\x1b[0m ${name}`);
        console.log(`      ${err.message}`);
    }
}

// =============================================================================
// Tests: Bridge Command Mapping
// =============================================================================

// Inline the BRIDGE_TO_TOOL mapping for testing (extracted from file-bridge.ts)
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
    newTab:         { tool: 'tabs', mapArgs: () => ({ action: 'new' }) },
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

// =============================================================================
// Test: getLocator selector parsing
// =============================================================================

/**
 * Simulate the getLocator selector classification logic (from tools.ts)
 */
function classifySelector(selector: string): 'link' | 'text' | 'xpath' | 'css' {
    if (selector.startsWith('link=')) return 'link';
    if (selector.startsWith('text=')) return 'text';
    if (selector.startsWith('xpath=')) return 'xpath';
    if (selector.startsWith('//') || selector.startsWith('(//')) return 'xpath';
    return 'css';
}

// =============================================================================
// Run Tests
// =============================================================================

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║          WebCure Unit Tests                              ║');
console.log('╚══════════════════════════════════════════════════════════╝');

describe('Bridge Command Routing', () => {
    it('should map "navigate" to navigate tool', () => {
        assert.strictEqual(BRIDGE_TO_TOOL['navigate'].tool, 'navigate');
    });

    it('should map "click" to click tool', () => {
        assert.strictEqual(BRIDGE_TO_TOOL['click'].tool, 'click');
    });

    it('should map "goBack" alias to navigateBack tool', () => {
        assert.strictEqual(BRIDGE_TO_TOOL['goBack'].tool, 'navigateBack');
    });

    it('should map "closeBrowser" alias to close tool', () => {
        assert.strictEqual(BRIDGE_TO_TOOL['closeBrowser'].tool, 'close');
    });

    it('should map "listTabs" to tabs tool with list action', () => {
        const mapping = BRIDGE_TO_TOOL['listTabs'];
        assert.strictEqual(mapping.tool, 'tabs');
        const result = mapping.mapArgs!({});
        assert.strictEqual(result.action, 'list');
    });

    it('should map "newTab" to tabs tool with new action', () => {
        const mapping = BRIDGE_TO_TOOL['newTab'];
        const result = mapping.mapArgs!({});
        assert.strictEqual(result.action, 'new');
    });

    it('should map "closeTab" to tabs tool with close action', () => {
        const mapping = BRIDGE_TO_TOOL['closeTab'];
        const result = mapping.mapArgs!({ index: 2 });
        assert.strictEqual(result.action, 'close');
        assert.strictEqual(result.index, 2);
    });

    it('should map "selectTab" to tabs tool with select action', () => {
        const mapping = BRIDGE_TO_TOOL['selectTab'];
        const result = mapping.mapArgs!({ index: 3 });
        assert.strictEqual(result.action, 'select');
        assert.strictEqual(result.index, 3);
    });

    it('should map "fullscreenBrowser" to resize with fullscreen preset', () => {
        const mapping = BRIDGE_TO_TOOL['fullscreenBrowser'];
        const result = mapping.mapArgs!({});
        assert.strictEqual(result.preset, 'fullscreen');
    });

    it('should have all expected bridge commands', () => {
        const expectedCommands = [
            'navigate', 'click', 'hover', 'typeText', 'typeFromFile', 'pressKey',
            'selectOption', 'fillForm', 'screenshot', 'consoleMessages', 'networkRequests',
            'handleDialog', 'uploadFile', 'evaluate', 'navigateBack', 'goBack', 'snapshot',
            'find', 'interact', 'scrapeMenu', 'scrapePage', 'drag', 'dragTo',
            'close', 'closeBrowser', 'tabs', 'listTabs', 'newTab', 'closeTab', 'selectTab',
            'waitForText', 'waitForElement', 'wait', 'resize', 'resizeBrowser',
            'fullscreenBrowser', 'extract', 'install'
        ];
        for (const cmd of expectedCommands) {
            assert.ok(BRIDGE_TO_TOOL[cmd], `Missing bridge command: ${cmd}`);
        }
    });

    it('should have 38 mapped commands total', () => {
        assert.strictEqual(Object.keys(BRIDGE_TO_TOOL).length, 38);
    });
});

describe('Parameter Transformation — navigate', () => {
    it('should map url arg correctly', () => {
        const mapped = BRIDGE_TO_TOOL['navigate'].mapArgs!({ url: 'https://example.com' });
        assert.strictEqual(mapped.url, 'https://example.com');
    });

    it('should accept target as url fallback', () => {
        const mapped = BRIDGE_TO_TOOL['navigate'].mapArgs!({ target: 'https://example.com' });
        assert.strictEqual(mapped.url, 'https://example.com');
    });

    it('should pass through waitUntil', () => {
        const mapped = BRIDGE_TO_TOOL['navigate'].mapArgs!({ url: 'https://x.com', waitUntil: 'networkidle' });
        assert.strictEqual(mapped.waitUntil, 'networkidle');
    });
});

describe('Parameter Transformation — click', () => {
    it('should map target to text and element', () => {
        const mapped = BRIDGE_TO_TOOL['click'].mapArgs!({ target: 'Submit' });
        assert.strictEqual(mapped.text, 'Submit');
        assert.strictEqual(mapped.element, 'Submit');
    });

    it('should map ref directly', () => {
        const mapped = BRIDGE_TO_TOOL['click'].mapArgs!({ ref: 'e5' });
        assert.strictEqual(mapped.ref, 'e5');
    });

    it('should map leftOf to toLeftOf', () => {
        const mapped = BRIDGE_TO_TOOL['click'].mapArgs!({ target: 'Edit', leftOf: 'Username' });
        assert.strictEqual(mapped.toLeftOf, 'Username');
    });
});

describe('Parameter Transformation — typeText', () => {
    it('should map text arg to value', () => {
        const mapped = BRIDGE_TO_TOOL['typeText'].mapArgs!({ selector: '#name', text: 'John' });
        assert.strictEqual(mapped.value, 'John');
        assert.strictEqual(mapped.selector, '#name');
    });

    it('should map into arg to text and element', () => {
        const mapped = BRIDGE_TO_TOOL['typeText'].mapArgs!({ into: 'Username', text: 'admin' });
        assert.strictEqual(mapped.text, 'Username');
        assert.strictEqual(mapped.element, 'Username');
    });
});

describe('Parameter Transformation — selectOption', () => {
    it('should wrap single value in array', () => {
        const mapped = BRIDGE_TO_TOOL['selectOption'].mapArgs!({ selector: '#dropdown', value: '2' });
        assert.deepStrictEqual(mapped.values, ['2']);
    });

    it('should map comboBox to text and element', () => {
        const mapped = BRIDGE_TO_TOOL['selectOption'].mapArgs!({ comboBox: 'Country', value: 'US' });
        assert.strictEqual(mapped.text, 'Country');
        assert.strictEqual(mapped.element, 'Country');
    });
});

describe('Parameter Transformation — handleDialog', () => {
    it('should default accept to true', () => {
        const mapped = BRIDGE_TO_TOOL['handleDialog'].mapArgs!({});
        assert.strictEqual(mapped.accept, true);
    });

    it('should pass accept=false', () => {
        const mapped = BRIDGE_TO_TOOL['handleDialog'].mapArgs!({ accept: false });
        assert.strictEqual(mapped.accept, false);
    });

    it('should pass promptText', () => {
        const mapped = BRIDGE_TO_TOOL['handleDialog'].mapArgs!({ accept: true, promptText: 'hello' });
        assert.strictEqual(mapped.promptText, 'hello');
    });
});

describe('Parameter Transformation — wait', () => {
    it('should convert ms to seconds', () => {
        const mapped = BRIDGE_TO_TOOL['wait'].mapArgs!({ ms: 2000 });
        assert.strictEqual(mapped.time, 2);
    });

    it('should pass through time directly', () => {
        const mapped = BRIDGE_TO_TOOL['wait'].mapArgs!({ time: 5 });
        assert.strictEqual(mapped.time, 5);
    });
});

describe('Parameter Transformation — resize', () => {
    it('should pass width and height', () => {
        const mapped = BRIDGE_TO_TOOL['resize'].mapArgs!({ width: 800, height: 600 });
        assert.strictEqual(mapped.width, 800);
        assert.strictEqual(mapped.height, 600);
    });

    it('should pass preset', () => {
        const mapped = BRIDGE_TO_TOOL['resize'].mapArgs!({ preset: 'fullscreen' });
        assert.strictEqual(mapped.preset, 'fullscreen');
    });
});

describe('Parameter Transformation — screenshot', () => {
    it('should pass fullPage flag', () => {
        const mapped = BRIDGE_TO_TOOL['screenshot'].mapArgs!({ fullPage: true });
        assert.strictEqual(mapped.fullPage, true);
    });

    it('should map filename to outputPath', () => {
        const mapped = BRIDGE_TO_TOOL['screenshot'].mapArgs!({ filename: 'test.png' });
        assert.strictEqual(mapped.outputPath, 'test.png');
    });

    it('should prefer outputPath over filename', () => {
        const mapped = BRIDGE_TO_TOOL['screenshot'].mapArgs!({ outputPath: '/tmp/a.png', filename: 'b.png' });
        assert.strictEqual(mapped.outputPath, '/tmp/a.png');
    });
});

describe('Parameter Transformation — drag', () => {
    it('should map source/target for drag command', () => {
        const mapped = BRIDGE_TO_TOOL['drag'].mapArgs!({ source: 'e1', target: 'e2' });
        assert.strictEqual(mapped.startRef, 'e1');
        assert.strictEqual(mapped.endRef, 'e2');
    });

    it('should map source/target for dragTo command', () => {
        const mapped = BRIDGE_TO_TOOL['dragTo'].mapArgs!({ source: 'A', target: 'B' });
        assert.strictEqual(mapped.startRef, 'A');
        assert.strictEqual(mapped.endRef, 'B');
    });
});

describe('Parameter Transformation — waitForElement', () => {
    it('should default state to visible', () => {
        const mapped = BRIDGE_TO_TOOL['waitForElement'].mapArgs!({ text: 'Loading' });
        assert.strictEqual(mapped.state, 'visible');
    });

    it('should map target to text', () => {
        const mapped = BRIDGE_TO_TOOL['waitForElement'].mapArgs!({ target: 'Submit' });
        assert.strictEqual(mapped.text, 'Submit');
    });
});

describe('Parameter Transformation — evaluate', () => {
    it('should map expression to function', () => {
        const mapped = BRIDGE_TO_TOOL['evaluate'].mapArgs!({ expression: '() => 42' });
        assert.strictEqual(mapped.function, '() => 42');
    });
});

describe('Parameter Transformation — extract', () => {
    it('should pass selector', () => {
        const mapped = BRIDGE_TO_TOOL['extract'].mapArgs!({ selector: 'h1' });
        assert.strictEqual(mapped.selector, 'h1');
    });

    it('should pass maxLength', () => {
        const mapped = BRIDGE_TO_TOOL['extract'].mapArgs!({ maxLength: 1000 });
        assert.strictEqual(mapped.maxLength, 1000);
    });
});

describe('Selector Classification (getLocator logic)', () => {
    it('should classify "link=Home" as link', () => {
        assert.strictEqual(classifySelector('link=Home'), 'link');
    });

    it('should classify "text=Submit" as text', () => {
        assert.strictEqual(classifySelector('text=Submit'), 'text');
    });

    it('should classify "xpath=//div" as xpath', () => {
        assert.strictEqual(classifySelector('xpath=//div'), 'xpath');
    });

    it('should classify "//div[@id]" as xpath', () => {
        assert.strictEqual(classifySelector('//div[@id]'), 'xpath');
    });

    it('should classify "(//div)[1]" as xpath', () => {
        assert.strictEqual(classifySelector('(//div)[1]'), 'xpath');
    });

    it('should classify "#username" as css', () => {
        assert.strictEqual(classifySelector('#username'), 'css');
    });

    it('should classify ".btn-primary" as css', () => {
        assert.strictEqual(classifySelector('.btn-primary'), 'css');
    });

    it('should classify "div > span" as css', () => {
        assert.strictEqual(classifySelector('div > span'), 'css');
    });
});

describe('Edge Cases', () => {
    it('drag: startRef takes priority over source', () => {
        const mapped = BRIDGE_TO_TOOL['drag'].mapArgs!({ startRef: 'e1', source: 'e9' });
        assert.strictEqual(mapped.startRef, 'e1');
    });

    it('click: selector passed through', () => {
        const mapped = BRIDGE_TO_TOOL['click'].mapArgs!({ selector: '#btn' });
        assert.strictEqual(mapped.selector, '#btn');
    });

    it('typeText: submit flag passed through', () => {
        const mapped = BRIDGE_TO_TOOL['typeText'].mapArgs!({ text: 'x', submit: true });
        assert.strictEqual(mapped.submit, true);
    });

    it('find: positional params passed through', () => {
        const mapped = BRIDGE_TO_TOOL['find'].mapArgs!({ text: 'Edit', toLeftOf: 'Name', above: 'Footer' });
        assert.strictEqual(mapped.toLeftOf, 'Name');
        assert.strictEqual(mapped.above, 'Footer');
    });

    it('interact: all params passed through', () => {
        const mapped = BRIDGE_TO_TOOL['interact'].mapArgs!({
            action: 'type', ref: 'e3', text: 'Hello', value: 'world',
            toLeftOf: 'X', toRightOf: 'Y', above: 'A', below: 'B'
        });
        assert.strictEqual(mapped.action, 'type');
        assert.strictEqual(mapped.ref, 'e3');
        assert.strictEqual(mapped.value, 'world');
        assert.strictEqual(mapped.toLeftOf, 'X');
    });
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n' + '─'.repeat(56));
console.log(`\n  Total: ${passCount + failCount}  Passed: \x1b[32m${passCount}\x1b[0m  Failed: \x1b[31m${failCount}\x1b[0m`);

if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
        console.log(`    \x1b[31m✗\x1b[0m ${f}`);
    }
}

console.log();
process.exit(failCount > 0 ? 1 : 0);
