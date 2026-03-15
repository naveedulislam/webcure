/**
 * WebCure — Step Recorder Python Generation — Unit Tests
 *
 * Tests the Python script generation logic inlined from step-recorder.ts.
 * Pure functions are inlined here to avoid the vscode/browser dependency that
 * exists in the source file.  This means the tests validate the business logic
 * directly and do NOT depend on a compiled extension or running VS Code instance.
 *
 * Run with:
 *   npx tsx tests/unit/step-recorder.test.ts
 *
 * Coverage:
 *   §1   pyStr — Python string escaping
 *   §2   buildFallbackLocators — CSS/XPath fallback generation
 *   §3   locatorsToRepr — Python list literal serialisation
 *   §4   stepToPythonLines — navigate step
 *   §5   stepToPythonLines — close step (skipped)
 *   §6   stepToPythonLines — sleep step
 *   §7   stepToPythonLines — fileupload step
 *   §8   stepToPythonLines — select step
 *   §9   stepToPythonLines — click step
 *   §10  stepToPythonLines — type step
 *   §11  stepToPythonLines — keydown step
 *   §12  stepToPythonLines — file-input suppression
 *   §13  stepToPythonLines — no locators / no fallback
 *   §14  generateStepsPythonScript — script structure
 *   §15  generateStepsPythonScript — Browser close event skipped
 *   §16  generateStepsPythonScript — defaultWaitSeconds = 0 (no injection)
 *   §17  generateStepsPythonScript — defaultWaitSeconds > 0 (injection after action steps)
 *   §18  generateStepsPythonScript — defaultWaitSeconds NOT injected after navigate/sleep
 */

import * as assert from 'assert';

// =============================================================================
// Lightweight test harness (no external framework)
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
// Inlined pure functions from src/recorder/step-recorder.ts
// These are the exact same functions — keep in sync when the source changes.
// =============================================================================

function pyStr(val: any): string {
    const s = String(val ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${s}"`;
}

function buildFallbackLocators(step: any): any[] {
    const locs: any[] = [];
    if (step.cssSelector) locs.push({ strategy: 'css',   value: step.cssSelector, confidence: 0.4 });
    if (step.xpath)       locs.push({ strategy: 'xpath', value: step.xpath,       confidence: 0.3 });
    return locs;
}

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

    if (type === 'sleep') {
        const secs = step.seconds ?? 1;
        lines.push(`${indent}time.sleep(${secs})  # Wait ${secs}s`);
        lines.push('');
        return lines;
    }

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

/** Stub version — mirrors the structure of the real generateStepsPythonScript
 *  but replaces the large PYTHON_HELPERS constant with a marker token so we
 *  can assert on script structure without embedding 200+ lines of helper code. */
function generateStepsPythonScript(steps: any[], defaultWaitSeconds = 0): string {
    const lines: string[] = [];
    const indent = '        ';

    lines.push('#!/usr/bin/env python3');
    lines.push('# Auto-generated by WebCure Step Recorder');
    lines.push('# <PYTHON_HELPERS>');
    lines.push('');
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

// =============================================================================
// Sample locators reused across tests
// =============================================================================

const SAMPLE_LOCATORS = [
    { strategy: 'id',       value: 'username',       confidence: 0.95 },
    { strategy: 'ariaLabel', value: 'Username',      confidence: 0.85 },
    { strategy: 'css',      value: "input[name='uid']", confidence: 0.6 },
];

const INDENT = '        '; // 8-space indent (matches the real generator)

// =============================================================================
// Run Tests
// =============================================================================

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║    WebCure — Step Recorder Python Generation Tests       ║');
console.log('╚══════════════════════════════════════════════════════════╝');

// ─── §1  pyStr ───────────────────────────────────────────────────────────────
describe('§1  pyStr — Python string escaping', () => {
    it('wraps a plain string in double quotes', () => {
        assert.strictEqual(pyStr('hello'), '"hello"');
    });

    it('escapes internal double quotes', () => {
        assert.strictEqual(pyStr('say "hi"'), '"say \\"hi\\""');
    });

    it('escapes backslashes', () => {
        assert.strictEqual(pyStr('C:\\path\\file'), '"C:\\\\path\\\\file"');
    });

    it('converts null to empty string', () => {
        assert.strictEqual(pyStr(null), '""');
    });

    it('converts undefined to empty string', () => {
        assert.strictEqual(pyStr(undefined), '""');
    });

    it('converts numbers to strings', () => {
        assert.strictEqual(pyStr(42), '"42"');
    });
});

// ─── §2  buildFallbackLocators ───────────────────────────────────────────────
describe('§2  buildFallbackLocators', () => {
    it('returns empty array when no cssSelector or xpath', () => {
        assert.deepStrictEqual(buildFallbackLocators({}), []);
    });

    it('returns css strategy from cssSelector', () => {
        const locs = buildFallbackLocators({ cssSelector: '#login-btn' });
        assert.strictEqual(locs.length, 1);
        assert.strictEqual(locs[0].strategy, 'css');
        assert.strictEqual(locs[0].value, '#login-btn');
        assert.strictEqual(locs[0].confidence, 0.4);
    });

    it('returns xpath strategy from xpath', () => {
        const locs = buildFallbackLocators({ xpath: '//button[@id="login"]' });
        assert.strictEqual(locs.length, 1);
        assert.strictEqual(locs[0].strategy, 'xpath');
        assert.strictEqual(locs[0].value, '//button[@id="login"]');
        assert.strictEqual(locs[0].confidence, 0.3);
    });

    it('returns both when cssSelector and xpath are present', () => {
        const locs = buildFallbackLocators({ cssSelector: '#btn', xpath: '//button' });
        assert.strictEqual(locs.length, 2);
        assert.strictEqual(locs[0].strategy, 'css');
        assert.strictEqual(locs[1].strategy, 'xpath');
    });
});

// ─── §3  locatorsToRepr ──────────────────────────────────────────────────────
describe('§3  locatorsToRepr — Python list serialisation', () => {
    it('returns "[]" when no locators and no fallback', () => {
        assert.strictEqual(locatorsToRepr([], {}, INDENT), '[]');
    });

    it('uses fallback when locator array is empty', () => {
        const repr = locatorsToRepr([], { cssSelector: '#btn' }, INDENT);
        assert.ok(repr.includes('"css"'), 'should use css fallback strategy');
        assert.ok(repr.includes('"#btn"'), 'should include css value');
    });

    it('uses provided locators when present', () => {
        const repr = locatorsToRepr(SAMPLE_LOCATORS, {}, INDENT);
        assert.ok(repr.includes('"id"'));
        assert.ok(repr.includes('"username"'));
        assert.ok(repr.includes('"ariaLabel"'));
    });

    it('each entry has strategy, value, and confidence keys', () => {
        const repr = locatorsToRepr(SAMPLE_LOCATORS, {}, INDENT);
        assert.ok(repr.includes('"strategy"'));
        assert.ok(repr.includes('"value"'));
        assert.ok(repr.includes('"confidence"'));
    });

    it('opens with [ and closes with ]', () => {
        const repr = locatorsToRepr(SAMPLE_LOCATORS, {}, INDENT);
        assert.ok(repr.startsWith('['));
        assert.ok(repr.trimEnd().endsWith(']'));
    });
});

// ─── §4  stepToPythonLines — navigate ────────────────────────────────────────
describe('§4  stepToPythonLines — navigate', () => {
    it('generates page.goto with url field', () => {
        const lines = stepToPythonLines({ type: 'navigate', url: 'https://example.com' }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('page.goto("https://example.com")')));
    });

    it('generates wait_for_load_state after goto', () => {
        const lines = stepToPythonLines({ type: 'navigate', url: 'https://example.com' }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('page.wait_for_load_state("networkidle")')));
    });

    it('strips "Navigated to " prefix from text field', () => {
        const lines = stepToPythonLines({ type: 'navigate', text: 'Navigated to https://foo.bar' }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('page.goto("https://foo.bar")')));
    });

    it('emits comment when no URL captured', () => {
        const lines = stepToPythonLines({ type: 'navigate' }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('URL not captured')));
    });

    it('uses url field over text field', () => {
        const lines = stepToPythonLines({ type: 'navigate', url: 'https://a.com', text: 'https://b.com' }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('"https://a.com"')));
        assert.ok(!lines.some(l => l.includes('"https://b.com"')));
    });
});

// ─── §5  stepToPythonLines — close ───────────────────────────────────────────
describe('§5  stepToPythonLines — close (skipped)', () => {
    it('produces only a comment line and empty line', () => {
        const lines = stepToPythonLines({ type: 'close' }, 1, INDENT);
        // Only the leading comment + blank line — no actual code
        const code = lines.filter(l => l.trim() && !l.trim().startsWith('#'));
        assert.strictEqual(code.length, 0, 'expected no executable code for close step');
    });
});

// ─── §6  stepToPythonLines — sleep ───────────────────────────────────────────
describe('§6  stepToPythonLines — sleep', () => {
    it('generates time.sleep with specified seconds', () => {
        const lines = stepToPythonLines({ type: 'sleep', seconds: 2 }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('time.sleep(2)')));
    });

    it('defaults to 1 second when seconds is not specified', () => {
        const lines = stepToPythonLines({ type: 'sleep' }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('time.sleep(1)')));
    });

    it('includes Wait comment', () => {
        const lines = stepToPythonLines({ type: 'sleep', seconds: 3 }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('Wait 3s')));
    });
});

// ─── §7  stepToPythonLines — fileupload ──────────────────────────────────────
describe('§7  stepToPythonLines — fileupload', () => {
    it('generates upload_file call with file path', () => {
        const lines = stepToPythonLines({
            type: 'fileupload',
            filePath: '/home/user/resume.pdf',
            locators: SAMPLE_LOCATORS,
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('upload_file(page,')));
        assert.ok(lines.some(l => l.includes('"/home/user/resume.pdf"')));
    });

    it('emits TODO placeholder when filePath is absent', () => {
        const lines = stepToPythonLines({ type: 'fileupload', locators: SAMPLE_LOCATORS }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('# TODO')));
        assert.ok(lines.some(l => l.includes('/path/to/your/file')));
    });

    it('emits TODO placeholder when filePath is empty string', () => {
        const lines = stepToPythonLines({ type: 'fileupload', filePath: '', locators: SAMPLE_LOCATORS }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('# TODO')));
    });

    it('escapes special chars in file path', () => {
        const lines = stepToPythonLines({
            type: 'fileupload',
            filePath: '/path/with "spaces"/file.pdf',
            locators: SAMPLE_LOCATORS,
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('\\"spaces\\"')));
    });
});

// ─── §8  stepToPythonLines — select ──────────────────────────────────────────
describe('§8  stepToPythonLines — select (HTML <select>)', () => {
    it('generates self_healing_select with label', () => {
        const lines = stepToPythonLines({
            type: 'select',
            label: 'Active',
            locators: SAMPLE_LOCATORS,
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('self_healing_select(page,')));
        assert.ok(lines.some(l => l.includes('"Active"')));
    });

    it('falls back to value when label is absent', () => {
        const lines = stepToPythonLines({
            type: 'select',
            value: 'active',
            locators: SAMPLE_LOCATORS,
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('"active"')));
    });

    it('uses label over value when both are present', () => {
        const lines = stepToPythonLines({
            type: 'select',
            label: 'Active',
            value: 'active',
            locators: SAMPLE_LOCATORS,
        }, 1, INDENT);
        const selectLine = lines.find(l => l.includes('self_healing_select'));
        assert.ok(selectLine?.includes('"Active"'), 'label should take priority');
    });

    it('uses empty string when neither label nor value given', () => {
        const lines = stepToPythonLines({ type: 'select', locators: SAMPLE_LOCATORS }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('self_healing_select') && l.includes('""')));
    });
});

// ─── §9  stepToPythonLines — click ───────────────────────────────────────────
describe('§9  stepToPythonLines — click', () => {
    it('generates self_healing_click', () => {
        const lines = stepToPythonLines({ type: 'click', locators: SAMPLE_LOCATORS }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('self_healing_click(page,')));
    });

    it('uses fallback locators when list is empty', () => {
        const lines = stepToPythonLines({
            type: 'click',
            locators: [],
            cssSelector: '#submit',
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('self_healing_click')));
        assert.ok(lines.some(l => l.includes('"#submit"')));
    });
});

// ─── §10  stepToPythonLines — type ───────────────────────────────────────────
describe('§10  stepToPythonLines — type', () => {
    it('generates self_healing_fill with value', () => {
        const lines = stepToPythonLines({
            type: 'type',
            value: 'admin',
            locators: SAMPLE_LOCATORS,
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('self_healing_fill(page,')));
        assert.ok(lines.some(l => l.includes('"admin"')));
    });

    it('uses empty string when value is absent', () => {
        const lines = stepToPythonLines({ type: 'type', locators: SAMPLE_LOCATORS }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('self_healing_fill') && l.includes('""')));
    });
});

// ─── §11  stepToPythonLines — keydown ────────────────────────────────────────
describe('§11  stepToPythonLines — keydown', () => {
    it('generates self_healing_press with key name', () => {
        const lines = stepToPythonLines({
            type: 'keydown',
            key: 'Enter',
            locators: SAMPLE_LOCATORS,
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('self_healing_press(page,')));
        assert.ok(lines.some(l => l.includes('"Enter"')));
    });

    it('emits no-action comment when key is absent', () => {
        const lines = stepToPythonLines({ type: 'keydown', locators: SAMPLE_LOCATORS }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('# keydown') && l.includes('no automation generated')));
    });
});

// ─── §12  stepToPythonLines — file-input suppression ─────────────────────────
describe('§12  stepToPythonLines — file-input click/change suppression', () => {
    it('suppresses click on input[type=file] via inputType', () => {
        const lines = stepToPythonLines({
            type: 'click',
            tagName: 'input',
            inputType: 'file',
            locators: SAMPLE_LOCATORS,
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('file-input click/change skipped')));
        assert.ok(!lines.some(l => l.includes('self_healing_click')));
    });

    it('suppresses click on input when cssSelector contains type="file"', () => {
        const lines = stepToPythonLines({
            type: 'click',
            tagName: 'input',
            cssSelector: 'input[type="file"]',
            locators: [],
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('file-input click/change skipped')));
    });

    it('suppresses when xpath contains @type="file"', () => {
        const lines = stepToPythonLines({
            type: 'click',
            tagName: 'input',
            xpath: '//input[@type="file"]',
            locators: [],
        }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('file-input click/change skipped')));
    });
});

// ─── §13  stepToPythonLines — no locators / no fallback ──────────────────────
describe('§13  stepToPythonLines — no locators and no fallback', () => {
    it('emits a "Could not generate locator" comment', () => {
        const lines = stepToPythonLines({ type: 'click', locators: [] }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('Could not generate locator')));
        assert.ok(!lines.some(l => l.includes('self_healing_click')));
    });

    it('includes the step type in the comment', () => {
        const lines = stepToPythonLines({ type: 'click', tagName: 'button', locators: [] }, 1, INDENT);
        assert.ok(lines.some(l => l.includes('click') && l.includes('<button>')));
    });
});

// ─── §14  generateStepsPythonScript — structure ──────────────────────────────
describe('§14  generateStepsPythonScript — script structure', () => {
    const script = generateStepsPythonScript([]);

    it('starts with shebang line', () => {
        assert.ok(script.startsWith('#!/usr/bin/env python3'));
    });

    it('contains test_recorded_flow function', () => {
        assert.ok(script.includes('def test_recorded_flow():'));
    });

    it('launches a Chromium browser', () => {
        assert.ok(script.includes('p.chromium.launch'));
    });

    it('creates a new page', () => {
        assert.ok(script.includes('browser.new_page()'));
    });

    it('closes the browser', () => {
        assert.ok(script.includes('browser.close()'));
    });

    it('has __main__ guard', () => {
        assert.ok(script.includes('if __name__ == "__main__":'));
        assert.ok(script.includes('test_recorded_flow()'));
    });
});

// ─── §15  generateStepsPythonScript — Browser close skipped ──────────────────
describe('§15  generateStepsPythonScript — Browser close event skipped', () => {
    it('does not emit code for a Browser-close event', () => {
        const steps = [
            { type: 'navigate', url: 'https://example.com' },
            { type: 'close', tagName: 'Browser' },
        ];
        const script = generateStepsPythonScript(steps);
        // Only 1 step comment expected (navigate)
        const stepComments = script.match(/# Step \d+:/g) || [];
        assert.strictEqual(stepComments.length, 1, 'Browser close should not produce a step entry');
    });
});

// ─── §16  generateStepsPythonScript — no defaultWaitSeconds ──────────────────
describe('§16  generateStepsPythonScript — defaultWaitSeconds = 0 (no injection)', () => {
    it('does not add time.sleep between steps when defaultWaitSeconds is 0', () => {
        const steps = [
            { type: 'navigate', url: 'https://example.com' },
            { type: 'click', locators: SAMPLE_LOCATORS, description: 'Click login' },
            { type: 'type',  locators: SAMPLE_LOCATORS, value: 'admin', description: 'Type username' },
        ];
        const script = generateStepsPythonScript(steps, 0);
        // Only sleep steps explicitly recorded should appear — none here
        assert.ok(!script.includes('default wait between steps'));
    });
});

// ─── §17  generateStepsPythonScript — defaultWaitSeconds > 0 ─────────────────
describe('§17  generateStepsPythonScript — defaultWaitSeconds > 0 (injection)', () => {
    const steps = [
        { type: 'navigate', url: 'https://example.com' },
        { type: 'click', locators: SAMPLE_LOCATORS, description: 'Click login' },
        { type: 'type',  locators: SAMPLE_LOCATORS, value: 'admin', description: 'Type username' },
    ];

    it('injects time.sleep after each action step (click, type)', () => {
        const script = generateStepsPythonScript(steps, 1);
        const matches = script.match(/time\.sleep\(1\)  # default wait between steps/g) || [];
        // click + type → 2 injections; navigate gets no injection
        assert.strictEqual(matches.length, 2);
    });

    it('uses the configured wait duration', () => {
        const script = generateStepsPythonScript(steps, 2.5);
        assert.ok(script.includes('time.sleep(2.5)  # default wait between steps'));
    });

    it('injected sleep appears BEFORE the trailing blank line of the step', () => {
        const script = generateStepsPythonScript(steps, 1);
        // The sleep line should immediately precede an empty line
        const scriptLines = script.split('\n');
        const sleepIdx = scriptLines.findIndex(l => l.includes('default wait between steps'));
        assert.ok(sleepIdx !== -1, 'sleep line should be present');
        assert.strictEqual(scriptLines[sleepIdx + 1], '', 'blank line should follow the sleep');
    });
});

// ─── §18  defaultWaitSeconds NOT injected after navigate / sleep ──────────────
describe('§18  generateStepsPythonScript — no injection after navigate/sleep', () => {
    it('does not inject after navigate steps', () => {
        const steps = [
            { type: 'navigate', url: 'https://example.com' },
        ];
        const script = generateStepsPythonScript(steps, 1);
        assert.ok(!script.includes('default wait between steps'));
    });

    it('does not inject after explicit sleep steps', () => {
        const steps = [
            { type: 'sleep', seconds: 2 },
        ];
        const script = generateStepsPythonScript(steps, 1);
        // Only the explicit time.sleep — NOT the default-wait line
        assert.ok(!script.includes('default wait between steps'));
        assert.ok(script.includes('time.sleep(2)  # Wait 2s'));
    });

    it('does not inject after a non-Browser close step', () => {
        // close with tagName != 'Browser' is still skipped by the generator loop
        const steps = [
            { type: 'close', tagName: 'Window' },
        ];
        const script = generateStepsPythonScript(steps, 1);
        assert.ok(!script.includes('default wait between steps'));
    });
});

// =============================================================================
// Summary
// =============================================================================

console.log('\n────────────────────────────────────────────────────────────');
if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
        console.log(`  \x1b[31m✗\x1b[0m ${f}`);
    }
}
console.log(`\n  Total: ${passCount + failCount}  \x1b[32mPassed: ${passCount}\x1b[0m  \x1b[31mFailed: ${failCount}\x1b[0m\n`);
process.exit(failCount > 0 ? 1 : 0);
