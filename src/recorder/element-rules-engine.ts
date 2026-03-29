// ---------------------------------------------------------------------------
// WebCure — HTML Element Rules Engine (Browser-injected)
//
// Standards-based element classification, locator generation, and label
// extraction.  Designed to run inside a browser page via Playwright's
// page.addInitScript().  All code must be self-contained (no imports).
//
// References:
//   • HTML Living Standard  — https://html.spec.whatwg.org/
//   • WAI-ARIA 1.2          — https://www.w3.org/TR/wai-aria-1.2/
//   • Accessible Name Spec  — https://www.w3.org/TR/accname-1.2/
// ---------------------------------------------------------------------------
//
// This file exports a single function `getEngineScript()` that returns the
// JavaScript source to be injected into the page.  The injected code exposes
// a global `__webcure` object with the engine API.
// ---------------------------------------------------------------------------

/**
 * Returns the self-contained JavaScript source code for the HTML Element
 * Rules Engine.  Call `page.addInitScript(getEngineScript())` to make
 * `window.__webcure` available in every frame.
 */
export function getEngineScript(): string {
    // The entire engine is authored as a template-literal string so it can be
    // injected verbatim.  Type-checking inside the string is intentionally
    // skipped — the code targets raw browser JS.
    return `
"use strict";
(() => {
    // Guard against double-injection
    if (window.__webcure) return;

    // ===================================================================
    // §1  ELEMENT CLASSIFICATION — W3C / WHATWG role taxonomy
    // ===================================================================
    //
    // Every HTML element has an *implicit* ARIA role defined by the HTML-AAM
    // spec.  Authors can override it with an explicit role="..." attribute.
    // The engine resolves the effective role, then maps it to one of a small
    // set of high-level *semantic categories* used downstream for action
    // description and locator strategy selection.
    //
    // Categories:
    //   actionable  — buttons, links, menu items  (primary click targets)
    //   input       — text fields, search boxes, textareas
    //   toggle      — checkboxes, switches, radio buttons
    //   select      — <select>, combobox, listbox triggers
    //   option      — items inside a select/listbox/menu
    //   navigation  — nav landmarks, tabs, breadcrumbs
    //   container   — menus, dialogs, popovers, listboxes (wrappers)
    //   display     — headings, images, status, progress
    //   generic     — div, span, section — no semantic meaning
    // ===================================================================

    /**
     * Map from ARIA role (or implicit HTML-AAM role) → semantic category.
     */
    const ROLE_CATEGORY = {
        // actionable
        button:             'actionable',
        link:               'actionable',
        menuitem:           'actionable',
        menuitemcheckbox:   'actionable',
        menuitemradio:      'actionable',
        // input
        textbox:            'input',
        searchbox:          'input',
        spinbutton:         'input',
        // toggle
        checkbox:           'toggle',
        radio:              'toggle',
        switch:             'toggle',
        // select (triggers)
        combobox:           'select',
        listbox:            'select',
        // option
        option:             'option',
        treeitem:           'option',
        // navigation
        tab:                'navigation',
        tablist:            'navigation',
        navigation:         'navigation',
        // container
        menu:               'container',
        menubar:            'container',
        dialog:             'container',
        alertdialog:        'container',
        toolbar:            'container',
        tree:               'container',
        grid:               'container',
        treegrid:           'container',
        tabpanel:           'container',
        // display
        heading:            'display',
        img:                'display',
        status:             'display',
        progressbar:        'display',
        alert:              'display',
        log:                'display',
        tooltip:            'display',
    };

    // HTML elements that carry an implicit ARIA role per HTML-AAM.
    const IMPLICIT_ROLES = {
        a:        (el) => el.hasAttribute('href') ? 'link' : null,
        button:   () => 'button',
        input:    (el) => {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'checkbox')                       return 'checkbox';
            if (t === 'radio')                          return 'radio';
            if (['submit','reset','button','image'].includes(t)) return 'button';
            if (t === 'range')                          return 'slider';
            if (t === 'number')                         return 'spinbutton';
            if (t === 'search')                         return 'searchbox';
            return 'textbox';
        },
        select:   (el) => el.hasAttribute('multiple') ? 'listbox' : 'combobox',
        textarea: () => 'textbox',
        option:   () => 'option',
        img:      () => 'img',
        nav:      () => 'navigation',
        h1:       () => 'heading', h2: () => 'heading', h3: () => 'heading',
        h4:       () => 'heading', h5: () => 'heading', h6: () => 'heading',
        dialog:   () => 'dialog',
        details:  () => 'group',
        summary:  () => 'button',
        progress: () => 'progressbar',
        meter:    () => 'meter',
        output:   () => 'status',
        form:     () => 'form',
        table:    () => 'table',
        ul:       () => 'list', ol: () => 'list',
        li:       () => 'listitem',
    };

    /**
     * Resolve the effective ARIA role for an element.
     *   1.  Explicit role="..." attribute always wins (first token).
     *   2.  Implicit role from HTML-AAM mapping.
     *   3.  null for generic elements (div, span, etc.).
     */
    function resolveRole(el) {
        // 1. Explicit ARIA role
        const explicit = el.getAttribute('role');
        if (explicit) return explicit.trim().split(/\\s+/)[0].toLowerCase();
        // 2. Implicit role from HTML tag
        const tag = el.tagName.toLowerCase();
        const fn = IMPLICIT_ROLES[tag];
        if (fn) return fn(el);
        return null;
    }

    /**
     * Map a resolved role to a semantic category string.
     */
    function classifyRole(role) {
        if (!role) return 'generic';
        return ROLE_CATEGORY[role] || 'generic';
    }

    // ===================================================================
    // §2  INTERACTIVE ELEMENT RESOLUTION
    // ===================================================================
    // Given an arbitrary event target (which may be a deeply-nested span or
    // svg icon), walk upward to the nearest *semantically meaningful*
    // interactive ancestor.  This replaces the previous hard-coded selector
    // list with a standards-aware walk.

    /** Set of categories that represent user-interactive elements. */
    const INTERACTIVE_CATEGORIES = new Set([
        'actionable', 'input', 'toggle', 'select', 'option', 'navigation',
    ]);

    /**
     * Walk from \`target\` up toward the root to find the nearest ancestor
     * whose resolved role falls into an interactive category.  Returns the
     * target itself if nothing semantic is found (better than returning null
     * and losing the event).
     *
     * Stops at \`document.body\` and \`document.documentElement\`.
     */
    function resolveInteractiveElement(target) {
        if (!target || target === document.body || target === document.documentElement) return null;

        let el = target;
        while (el && el !== document.body && el !== document.documentElement) {
            const role = resolveRole(el);
            const cat  = classifyRole(role);
            if (INTERACTIVE_CATEGORIES.has(cat)) return el;
            el = el.parentElement;
        }

        // Fallback: check for common framework attributes that signal interactivity
        // even when the element lacks proper ARIA roles.
        // IMPORTANT: Skip top-level app containers (#root, #app, #__next, etc.)
        // because React 18+ and other frameworks attach event delegation to these
        // elements, making el.onclick truthy even though the container itself is
        // not an interactive target.
        el = target;
        while (el && el !== document.body && el !== document.documentElement) {
            // Skip root app containers — framework event delegation, not real interactivity
            const elId = (el.id || '').toLowerCase();
            const isAppRoot = el.parentElement === document.body &&
                (elId === 'root' || elId === 'app' || elId === '__next' || elId === '__nuxt');
            if (!isAppRoot) {
                if (el.hasAttribute('data-slot') || el.hasAttribute('data-radix-collection-item') ||
                    el.hasAttribute('data-headlessui-state') || el.hasAttribute('data-state') ||
                    el.getAttribute('tabindex') === '0' || el.onclick ||
                    (el.style && el.style.cursor === 'pointer')) {
                    return el;
                }
            }
            el = el.parentElement;
        }

        // Ultimate fallback — return original target so we don't lose the event
        return target;
    }

    // ===================================================================
    // §3  ACCESSIBLE NAME COMPUTATION  (simplified Acc-Name 1.2)
    // ===================================================================
    // Computes the human-readable name an assistive technology would
    // announce for this element.  The full spec is recursive; we implement
    // the most common paths.

    function getAccessibleName(el) {
        if (!el || el.nodeType !== 1) return '';

        // 1. aria-labelledby (space-separated IDs → concatenated text)
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
            const ids = labelledBy.trim().split(/\\s+/);
            const parts = ids.map((id) => {
                const ref = document.getElementById(id);
                return ref ? (ref.innerText || ref.textContent || '').trim() : '';
            }).filter(Boolean);
            if (parts.length) return parts.join(' ');
        }

        // 2. aria-label
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

        // 3. <label for="id"> association
        if (el.id) {
            const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (label) {
                const txt = (label.innerText || label.textContent || '').trim();
                if (txt) return txt;
            }
        }

        // 4. Enclosing <label>
        const parentLabel = el.closest('label');
        if (parentLabel) {
            const txt = (parentLabel.innerText || parentLabel.textContent || '').trim();
            if (txt) return txt;
        }

        // 5. title attribute
        if (el.title && el.title.trim()) return el.title.trim();

        // 6. placeholder (for inputs)
        if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();

        // 7. alt text (images, input type=image)
        if (el.alt && el.alt.trim()) return el.alt.trim();

        // 8. <input type="submit|button|reset"> — value attribute
        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (['submit', 'button', 'reset'].includes(type) && el.value) return el.value.trim();
        }

        // 9. Text content (for buttons, links, options, etc.)
        const text = (el.innerText || el.textContent || '').trim();
        if (text && text.length <= 200) return text;

        return '';
    }

    // ===================================================================
    // §4  CONTEXT RESOLUTION — dropdown / menu / dialog ownership
    // ===================================================================
    // When the user interacts with an element inside a portal-based overlay
    // (e.g. a Radix dropdown, Headless UI listbox), we resolve the owning
    // trigger / context so the step description reads:
    //   "Selected 'Edit' from 'Actions' dropdown"
    // instead of:
    //   "Clicked on div 'Edit'"

    /**
     * Attempt to find the trigger element that opened the container that
     * \`el\` lives in.  Uses three strategies:
     *   1. Walk up to a [role="menu"|"listbox"|"dialog"] container, then
     *      follow aria-labelledby back to the trigger.
     *   2. Match data-radix-popper-content-wrapper → look for a sibling trigger.
     *   3. Generic [aria-controls] reverse lookup.
     */
    function resolveOwningContext(el) {
        const ctx = { containerRole: null, triggerLabel: '', triggerEl: null };

        // 1. ARIA container walk
        const container = el.closest(
            '[role="menu"], [role="listbox"], [role="menubar"], [role="tree"], [role="dialog"], [role="alertdialog"]'
        );
        if (container) {
            ctx.containerRole = container.getAttribute('role');

            // aria-labelledby → trigger element
            const lblId = container.getAttribute('aria-labelledby');
            if (lblId) {
                const trigger = document.getElementById(lblId);
                if (trigger) {
                    ctx.triggerEl = trigger;
                    ctx.triggerLabel = getAccessibleName(trigger);
                }
            }
            // Fallback: aria-label on the container itself
            if (!ctx.triggerLabel) {
                const al = container.getAttribute('aria-label');
                if (al) ctx.triggerLabel = al.trim();
            }
        }

        // 2. Radix / Headless UI portal wrappers
        if (!ctx.triggerLabel) {
            const portalContent = el.closest(
                '[data-radix-popper-content-wrapper], [data-headlessui-state], [data-radix-menu-content], [data-radix-select-content]'
            );
            if (portalContent) {
                // Attempt to find the trigger via the portal's ID referenced by aria-controls
                const contentId = portalContent.id || (container && container.id);
                if (contentId) {
                    const trigger = document.querySelector('[aria-controls="' + CSS.escape(contentId) + '"]');
                    if (trigger) {
                        ctx.triggerEl = trigger;
                        ctx.triggerLabel = getAccessibleName(trigger);
                        if (!ctx.containerRole) ctx.containerRole = 'menu';
                    }
                }
            }
        }

        // 3. Generic aria-controls reverse lookup
        if (!ctx.triggerLabel && container && container.id) {
            const trigger = document.querySelector('[aria-controls="' + CSS.escape(container.id) + '"]');
            if (trigger) {
                ctx.triggerEl = trigger;
                ctx.triggerLabel = getAccessibleName(trigger);
            }
        }

        return ctx;
    }

    // ===================================================================
    // §5  LOCATOR STRATEGIES  (multi-strategy like Katalon / Selenium IDE)
    // ===================================================================
    // Generate an ordered array of locator strategies for the element.
    // Each locator is { strategy, value, confidence }.  Consumers pick the
    // best one or use them as fallback chain.

    /**
     * CSS selector via shortest unique path.
     */
    function buildCssSelector(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
            let seg = cur.tagName.toLowerCase();
            if (cur.id) {
                seg += '#' + CSS.escape(cur.id);
                parts.unshift(seg);
                break;
            }
            // nth-of-type disambiguation
            let sib = cur.previousElementSibling, nth = 1;
            while (sib) {
                if (sib.tagName.toLowerCase() === seg) nth++;
                sib = sib.previousElementSibling;
            }
            if (nth > 1) seg += ':nth-of-type(' + nth + ')';
            parts.unshift(seg);
            cur = cur.parentElement;
        }
        return parts.join(' > ');
    }

    /**
     * XPath — prefer id-anchored, else positional.
     */
    function buildXPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '//*[@id="' + el.id + '"]';
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1) {
            let prevCount = 0, hasNext = false;
            let sib = cur.previousSibling;
            while (sib) {
                if (sib.nodeType !== Node.DOCUMENT_TYPE_NODE && sib.nodeName === cur.nodeName) prevCount++;
                sib = sib.previousSibling;
            }
            sib = cur.nextSibling;
            while (sib) {
                if (sib.nodeName === cur.nodeName) { hasNext = true; break; }
                sib = sib.nextSibling;
            }
            const prefix = cur.prefix ? cur.prefix + ':' : '';
            const nth = (prevCount || hasNext) ? '[' + (prevCount + 1) + ']' : '';
            parts.push(prefix + cur.localName + nth);
            cur = cur.parentElement;
        }
        return parts.length ? '//' + parts.reverse().join('/') : '';
    }

    /**
     * data-testid / data-cy / data-test locators (highest priority when present).
     */
    function buildTestIdLocator(el) {
        for (const attr of ['data-testid', 'data-test-id', 'data-cy', 'data-test', 'data-qa']) {
            const val = el.getAttribute(attr);
            if (val) return { strategy: 'testId', value: '[' + attr + '="' + val + '"]', confidence: 1.0 };
        }
        return null;
    }

    /**
     * Text-based locator (link text, button text).
     */
    function buildTextLocator(el) {
        const role = resolveRole(el);
        const cat  = classifyRole(role);
        if (cat !== 'actionable') return null;
        const text = (el.innerText || el.textContent || '').trim();
        if (!text || text.length > 80) return null;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return { strategy: 'linkText', value: text, confidence: 0.85 };
        return { strategy: 'text', value: text, confidence: 0.80 };
    }

    /**
     * ARIA label locator.
     */
    function buildAriaLocator(el) {
        const name = getAccessibleName(el);
        const role = resolveRole(el);
        if (name && role) return { strategy: 'aria', value: role + '[name="' + name + '"]', confidence: 0.90 };
        if (name) return { strategy: 'ariaLabel', value: name, confidence: 0.70 };
        return null;
    }

    /**
     * Generate all locators for an element, sorted by confidence descending.
     */
    function generateLocators(el) {
        const locators = [];

        // Test IDs — most stable, highest confidence
        const tid = buildTestIdLocator(el);
        if (tid) locators.push(tid);

        // ARIA-based
        const aria = buildAriaLocator(el);
        if (aria) locators.push(aria);

        // Text-based
        const txt = buildTextLocator(el);
        if (txt) locators.push(txt);

        // CSS
        const css = buildCssSelector(el);
        if (css) locators.push({ strategy: 'css', value: css, confidence: 0.60 });

        // XPath — lowest priority, most brittle
        const xpath = buildXPath(el);
        if (xpath) locators.push({ strategy: 'xpath', value: xpath, confidence: 0.40 });

        // Name/id attribute
        if (el.name) locators.push({ strategy: 'name', value: el.name, confidence: 0.75 });
        if (el.id) locators.push({ strategy: 'id', value: el.id, confidence: 0.95 });

        locators.sort((a, b) => b.confidence - a.confidence);
        return locators;
    }

    // ===================================================================
    // §6  INPUT VALUE EXTRACTION
    // ===================================================================

    function extractInputValue(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (type === 'password') return '********';
            if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked';
            return el.value || '';
        }
        if (tag === 'select') {
            const opt = el.options[el.selectedIndex];
            return opt ? opt.text : el.value || '';
        }
        // ARIA checkbox / radio / switch (e.g. Radix <button role="checkbox" aria-checked="true">)
        const ariaChecked = el.getAttribute('aria-checked');
        if (ariaChecked !== null) return ariaChecked === 'true' ? 'checked' : 'unchecked';
        // contenteditable
        if (el.isContentEditable) return (el.innerText || '').trim();
        return undefined;
    }

    // ===================================================================
    // §7  LABEL EXTRACTION — enhanced heuristics for form fields
    // ===================================================================

    /**
     * Find the best human-readable label for an element.
     * Prioritises the accessible name, then falls back to DOM heuristics
     * for table-row forms and adjacent text nodes.
     */
    function extractLabel(el) {
        // 1. Accessible name (covers aria-labelledby, aria-label, <label>, title, placeholder)
        const accName = getAccessibleName(el);
        if (accName) return accName.replace(/:$/, '').trim();

        const tag = el.tagName.toLowerCase();
        const isFormField = ['input', 'textarea', 'select'].includes(tag);

        // 2. Table cell heuristic (common in legacy / enterprise forms)
        if (isFormField) {
            const td = el.closest('td');
            if (td) {
                let prev = td.previousElementSibling;
                while (prev && prev.tagName.toLowerCase() === 'td') {
                    const txt = (prev.innerText || prev.textContent || '').trim();
                    if (txt && txt.length < 80) return txt.replace(/:$/, '').trim();
                    prev = prev.previousElementSibling;
                }
            }
        }

        // 3. Previous sibling label text
        if (isFormField && el.previousElementSibling) {
            const sibTag = el.previousElementSibling.tagName.toLowerCase();
            if (['span', 'label', 'div', 'p', 'b', 'strong', 'em'].includes(sibTag)) {
                const txt = (el.previousElementSibling.innerText || '').trim();
                if (txt && txt.length < 80) return txt.replace(/:$/, '').trim();
            }
        }

        // 4. Previous text node
        if (isFormField && el.previousSibling && el.previousSibling.nodeType === Node.TEXT_NODE) {
            const txt = el.previousSibling.textContent.trim();
            if (txt && txt.length < 80) return txt.replace(/:$/, '').trim();
        }

        // 5. name / id as last resort
        if (el.name) return el.name;
        if (el.id) return el.id;

        return '';
    }

    // ===================================================================
    // §8  ACTION DESCRIPTION GENERATION
    // ===================================================================

    const CONTAINER_ROLE_TO_NOUN = {
        menu:       'dropdown',
        menubar:    'menu bar',
        listbox:    'list',
        tree:       'tree',
        dialog:     'dialog',
        alertdialog:'dialog',
    };

    /**
     * Produce a concise, human-readable action description.
     *   • "Clicked button 'Save'"
     *   • "Selected 'Edit' from 'Actions' dropdown"
     *   • "Typed 'hello' into 'Search'"
     *   • "Toggled 'Remember me' checkbox on"
     *   • "Pressed Enter on 'Username'"
     */
    function describeAction(type, el, extras) {
        const role   = resolveRole(el);
        const cat    = classifyRole(role);
        const label  = extractLabel(el);
        const safeLabel = label.substring(0, 60);
        extras = extras || {};

        // --- option / menuitem inside a container ---
        if (type === 'click' && (cat === 'option' || role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio' || role === 'treeitem')) {
            const ctx = resolveOwningContext(el);
            const noun = (ctx.containerRole && CONTAINER_ROLE_TO_NOUN[ctx.containerRole]) || 'menu';
            if (ctx.triggerLabel) {
                return "Selected '" + safeLabel + "' from '" + ctx.triggerLabel.substring(0, 40) + "' " + noun;
            }
            return "Selected menu item '" + safeLabel + "'";
        }

        // --- toggle (checkbox, switch, radio) ---
        if (type === 'click' && cat === 'toggle') {
            const state = el.checked ? 'on' : 'off';
            const kindName = role === 'switch' ? 'switch' : role === 'radio' ? 'radio' : 'checkbox';
            return "Toggled '" + safeLabel + "' " + kindName + " " + state;
        }

        // --- select / combobox trigger ---
        if (type === 'click' && cat === 'select') {
            return "Clicked " + (role || 'select') + " '" + safeLabel + "'";
        }

        // --- generic click on actionable element ---
        if (type === 'click') {
            const kindName = role === 'link' ? 'link' : cat === 'actionable' ? 'button' : (el.tagName || '').toLowerCase();
            return "Clicked " + kindName + " '" + safeLabel + "'";
        }

        // --- type ---
        if (type === 'type') {
            const value = extras.value !== undefined ? extras.value : extractInputValue(el);
            return "Typed '" + value + "' into '" + safeLabel + "'";
        }

        // --- keydown ---
        if (type === 'keydown' && extras.key) {
            return "Pressed " + extras.key + " on '" + safeLabel + "'";
        }

        // --- generic fallback ---
        return "Performed '" + type + "' on '" + safeLabel + "'";
    }

    // ===================================================================
    // §9  FULL ELEMENT INSPECTION — public API
    // ===================================================================

    /**
     * Master entry point.  Given a raw DOM element, returns a complete
     * inspection result:
     *
     *   { role, category, label, locators, context, description, ... }
     *
     * This is the ONLY function external code needs to call.
     */
    function inspectElement(el, eventType, extras) {
        if (!el || el.nodeType !== 1) return null;

        const role       = resolveRole(el);
        const category   = classifyRole(role);
        const label      = extractLabel(el);
        const accName    = getAccessibleName(el);
        const locators   = generateLocators(el);
        const context    = resolveOwningContext(el);
        const description = describeAction(eventType || 'click', el, extras);
        const inputValue = extractInputValue(el);
        const tag        = el.tagName.toLowerCase();
        const inputType  = el.getAttribute('type') || '';

        return {
            tagName:         el.tagName || '',
            role:            role || '',
            category:        category,
            label:           label,
            accessibleName:  accName,
            text:            (el.innerText || '').trim().substring(0, 200),
            id:              el.id || '',
            name:            el.getAttribute('name') || '',
            inputType:       inputType,
            placeholder:     el.getAttribute('placeholder') || '',
            ariaLabel:       el.getAttribute('aria-label') || '',
            title:           el.getAttribute('title') || '',
            value:           inputValue,
            locators:        locators,
            context: {
                containerRole: context.containerRole || '',
                triggerLabel:  context.triggerLabel  || '',
            },
            description: description,
            // Legacy compatibility fields (consumed by existing formatActionDescription):
            labelText:       label,
            buttonText:      tag === 'input' && ['submit','button','reset'].includes(inputType.toLowerCase()) ? (el.value || '') : '',
            menuTriggerLabel: context.triggerLabel || '',
            cssSelector:     (locators.find(l => l.strategy === 'css') || {}).value || '',
            xpath:           (locators.find(l => l.strategy === 'xpath') || {}).value || '',
        };
    }

    // ===================================================================
    // §10  EXPOSE PUBLIC API on window.__webcure
    // ===================================================================

    window.__webcure = {
        resolveRole:              resolveRole,
        classifyRole:             classifyRole,
        resolveInteractiveElement:resolveInteractiveElement,
        getAccessibleName:        getAccessibleName,
        resolveOwningContext:     resolveOwningContext,
        generateLocators:         generateLocators,
        extractLabel:             extractLabel,
        describeAction:           describeAction,
        inspectElement:           inspectElement,
    };
})();
`;
}
