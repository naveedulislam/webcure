#!/usr/bin/env python3
"""
WebCure — HTML Element Rules Engine — Live Browser Integration Tests (Python)

Launches a real Chromium browser, navigates to ACTUAL websites, injects the
engine, and verifies it correctly identifies element types, roles, labels,
locators, and action descriptions against real DOM structures.

Test targets:
  1. demo.testfire.net (AltoroMutual) — forms, links, navigation
  2. the-internet.herokuapp.com — checkboxes, dropdowns, inputs, tables
  3. Radix UI Themes Playground — portals, ARIA, custom components
  4. W3C WAI-ARIA Practices — reference tab/dialog implementations

Requirements:
  pip install playwright
  # Chromium binaries from ms-playwright cache or system Chrome

Run:
  python3 tests/integration/live_engine_test.py
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ─── Resolve Paths ────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SCREENSHOT_DIR = Path(__file__).resolve().parent / "screenshots"
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

# ─── Load Engine JS ───────────────────────────────────────────────────────────

def load_engine_js() -> str:
    """Extract the engine JS string from the compiled Node module."""
    result = subprocess.run(
        ["node", "-e",
         'const {getEngineScript} = require("./out/src/recorder/element-rules-engine");'
         'process.stdout.write(getEngineScript());'],
        capture_output=True, text=True, cwd=str(PROJECT_ROOT)
    )
    if result.returncode != 0:
        print(f"  ERROR: Could not load engine JS: {result.stderr}")
        sys.exit(2)
    return result.stdout

# ─── Test Harness ─────────────────────────────────────────────────────────────

pass_count = 0
fail_count = 0
failures = []
section_results = {}
current_section = ""

def section(name: str):
    global current_section
    current_section = name
    section_results[name] = {"pass": 0, "fail": 0}
    print(f"\n  \033[1m{name}\033[0m")

def test(name: str):
    """Decorator-style context manager for test cases."""
    class TestContext:
        def __enter__(self):
            return self
        def __exit__(self, exc_type, exc_val, exc_tb):
            global pass_count, fail_count
            if exc_type is None:
                pass_count += 1
                section_results[current_section]["pass"] += 1
                print(f"    \033[32m✓\033[0m {name}")
            else:
                fail_count += 1
                section_results[current_section]["fail"] += 1
                msg = str(exc_val).split("\n")[0]
                failures.append(f"[{current_section}] {name}: {msg}")
                print(f"    \033[31m✗\033[0m {name}")
                print(f"      \033[31m{msg}\033[0m")
            return True  # suppress exception
    return TestContext()

def assert_eq(actual, expected, label=""):
    if actual != expected:
        raise AssertionError(f'{label}: expected "{expected}", got "{actual}"')

def assert_in(needle, haystack, label=""):
    if needle not in (haystack or ""):
        raise AssertionError(f'{label}: expected "{haystack}" to contain "{needle}"')

def assert_one_of(actual, options, label=""):
    if actual not in options:
        raise AssertionError(f'{label}: expected one of {options}, got "{actual}"')

# ─── Browser Helpers ──────────────────────────────────────────────────────────

def find_chromium() -> str:
    """Find cached Playwright Chromium or system Chrome."""
    cache = Path.home() / "Library" / "Caches" / "ms-playwright"
    if cache.exists():
        dirs = sorted([d for d in cache.iterdir() if d.name.startswith("chromium-")], reverse=True)
        for d in dirs:
            for sub in [
                d / "chrome-mac-arm64" / "Google Chrome for Testing.app" / "Contents" / "MacOS" / "Google Chrome for Testing",
                d / "chrome-mac" / "Google Chrome for Testing.app" / "Contents" / "MacOS" / "Google Chrome for Testing",
                d / "chrome-mac" / "Chromium.app" / "Contents" / "MacOS" / "Chromium",
            ]:
                if sub.exists():
                    return str(sub)
    system = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if system.exists():
        return str(system)
    raise FileNotFoundError("No Chromium/Chrome binary found")

def inject_engine(page, engine_js: str):
    """Inject the rules engine into the page."""
    page.evaluate(engine_js)
    ready = page.evaluate("typeof window.__webcure?.inspectElement === 'function'")
    assert ready, "Engine injection failed"

def inspect(page, selector: str, action: str = "click", extra: dict = None) -> dict:
    """Inspect an element by CSS selector."""
    return page.evaluate(
        """({selector, action, extra}) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            return window.__webcure.inspectElement(el, action, extra || {});
        }""",
        {"selector": selector, "action": action, "extra": extra or {}}
    )

def screenshot(page, name: str):
    page.screenshot(path=str(SCREENSHOT_DIR / f"{name}.png"))

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    from playwright.sync_api import sync_playwright

    print("\n\033[1m══════════════════════════════════════════════════════════════\033[0m")
    print("\033[1m  WebCure — Live Browser Integration Tests (Python)\033[0m")
    print("\033[1m  Testing engine against REAL websites\033[0m")
    print("\033[1m══════════════════════════════════════════════════════════════\033[0m")

    engine_js = load_engine_js()
    print(f"  Engine JS loaded: {len(engine_js)} chars")

    chromium_path = find_chromium()
    print(f"  Browser: {chromium_path}")

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chromium_path, headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 800})

        # ═══════════════════════════════════════════════════════════════════
        # SITE 1: demo.testfire.net — Forms, Links, Navigation
        # ═══════════════════════════════════════════════════════════════════

        section("Site 1: demo.testfire.net — Navigation & Links")
        page = context.new_page()

        with test("navigate to AltoroMutual homepage"):
            page.goto("http://demo.testfire.net/", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)
            screenshot(page, "01-altoro-home")
            assert "Altoro" in page.title()

        with test("identify navigation links with roles and locators"):
            links = page.evaluate("""() => {
                const anchors = document.querySelectorAll('a[href]');
                const results = [];
                for (let i = 0; i < Math.min(anchors.length, 5); i++) {
                    const text = anchors[i].textContent?.trim();
                    if (text) {
                        const info = window.__webcure.inspectElement(anchors[i], 'click');
                        results.push({
                            text, role: info?.role, category: info?.category,
                            description: info?.description,
                            locatorCount: info?.locators?.length || 0
                        });
                    }
                }
                return results;
            }""")
            assert len(links) > 0, "No links found"
            for link in links:
                assert_eq(link["role"], "link", f'"{link["text"]}" role')
                assert_eq(link["category"], "actionable", f'"{link["text"]}" category')
                assert link["locatorCount"] > 0, f'"{link["text"]}" has locators'
            names = ", ".join(l["text"] for l in links)
            print(f"      verified {len(links)} links: {names}")

        with test("SIGN IN link identified correctly"):
            info = page.evaluate("""() => {
                const links = Array.from(document.querySelectorAll('a'));
                const si = links.find(a => (a.textContent||'').trim().toUpperCase() === 'SIGN IN');
                return si ? window.__webcure.inspectElement(si, 'click') : null;
            }""")
            assert info is not None, "SIGN IN link not found"
            assert_eq(info["role"], "link", "role")
            assert_in("link", info["description"], "description")
            print(f'      description: "{info["description"]}"')

        section("Site 1: demo.testfire.net — Login Form")

        with test("navigate to login page"):
            page.goto("http://demo.testfire.net/login.jsp", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)
            screenshot(page, "02-altoro-login")

        with test("username field: role=textbox, has name locator"):
            info = inspect(page, 'input[name="uid"]')
            assert info is not None, "username field not found"
            assert_eq(info["role"], "textbox", "role")
            assert_eq(info["category"], "input", "category")
            strategies = [l["strategy"] for l in info["locators"]]
            assert "name" in strategies, f"no name locator in {strategies}"
            print(f'      label: "{info["label"]}", locators: {", ".join(strategies)}')

        with test("password field: value obscured as ********"):
            page.fill('input[name="passw"]', "secretpass123")
            info = inspect(page, 'input[name="passw"]')
            assert_eq(info["value"], "********", "password value")
            print(f'      label: "{info["label"]}", value: {info["value"]}')

        with test("Login button: role=button, actionable"):
            info = inspect(page, 'input[type="submit"]')
            assert_eq(info["role"], "button", "role")
            assert_eq(info["category"], "actionable", "category")
            print(f'      description: "{info["description"]}"')
            print(f'      buttonText: "{info.get("buttonText", "")}"')

        with test("type event → Typed 'admin' into field"):
            info = inspect(page, 'input[name="uid"]', "type", {"value": "admin"})
            assert_in("Typed", info["description"], "description")
            assert_in("admin", info["description"], "value in desc")
            print(f'      description: "{info["description"]}"')

        with test("keydown Enter → Pressed Enter"):
            info = inspect(page, 'input[name="uid"]', "keydown", {"key": "Enter"})
            assert_in("Pressed", info["description"], "description")
            assert_in("Enter", info["description"], "key in desc")
            print(f'      description: "{info["description"]}"')

        page.close()

        # ═══════════════════════════════════════════════════════════════════
        # SITE 2: the-internet.herokuapp.com — Classic HTML Patterns
        # ═══════════════════════════════════════════════════════════════════

        section("Site 2: herokuapp — Checkboxes")
        page = context.new_page()

        with test("navigate to checkboxes page"):
            page.goto("https://the-internet.herokuapp.com/checkboxes", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)
            screenshot(page, "03-heroku-checkboxes")

        with test("checkbox: role=checkbox, category=toggle, Toggled description"):
            info = page.evaluate("""() => {
                const cb = document.querySelectorAll('input[type="checkbox"]')[0];
                return window.__webcure.inspectElement(cb, 'click');
            }""")
            assert_eq(info["role"], "checkbox", "role")
            assert_eq(info["category"], "toggle", "category")
            assert_one_of(info["value"], ["checked", "unchecked"], "value")
            assert_in("Toggled", info["description"], "description")
            print(f'      value: {info["value"]}, description: "{info["description"]}"')

        section("Site 2: herokuapp — Native <select> Dropdown")

        with test("navigate to dropdown page"):
            page.goto("https://the-internet.herokuapp.com/dropdown", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)
            screenshot(page, "04-heroku-dropdown")

        with test("<select> dropdown: role=combobox, category=select"):
            info = inspect(page, "#dropdown")
            assert_eq(info["role"], "combobox", "role")
            assert_eq(info["category"], "select", "category")
            strategies = [l["strategy"] for l in info["locators"]]
            print(f'      value: "{info["value"]}", locators: {", ".join(strategies)}')

        with test("select Option 1 → value changes"):
            page.select_option("#dropdown", "1")
            info = inspect(page, "#dropdown")
            assert_eq(info["value"], "Option 1", "selected value")
            print(f'      selected: "{info["value"]}"')

        section("Site 2: herokuapp — Number Input")

        with test("navigate to inputs page"):
            page.goto("https://the-internet.herokuapp.com/inputs", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)
            screenshot(page, "05-heroku-inputs")

        with test("number input: role=spinbutton, type event"):
            info = inspect(page, 'input[type="number"]', "type", {"value": "42"})
            assert_eq(info["role"], "spinbutton", "role")
            assert_eq(info["category"], "input", "category")
            assert_in("Typed", info["description"], "description")
            assert_in("42", info["description"], "value")
            print(f'      description: "{info["description"]}"')

        section("Site 2: herokuapp — Key Presses")

        with test("navigate to key_presses page"):
            page.goto("https://the-internet.herokuapp.com/key_presses", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)
            screenshot(page, "06-heroku-keys")

        with test("keydown Tab → Pressed Tab"):
            info = inspect(page, "#target", "keydown", {"key": "Tab"})
            assert_in("Pressed", info["description"], "description")
            assert_in("Tab", info["description"], "key")
            print(f'      description: "{info["description"]}"')

        section("Site 2: herokuapp — Links with linkText Locators")

        with test("navigate to homepage"):
            page.goto("https://the-internet.herokuapp.com/", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)

        with test("links have role=link and linkText locators"):
            results = page.evaluate("""() => {
                const links = document.querySelectorAll('ul li a');
                const out = [];
                for (let i = 0; i < Math.min(links.length, 8); i++) {
                    const info = window.__webcure.inspectElement(links[i], 'click');
                    out.push({
                        text: info.text, role: info.role, category: info.category,
                        linkText: info.locators.find(l => l.strategy === 'linkText')?.value
                    });
                }
                return out;
            }""")
            assert len(results) > 0
            for r in results:
                assert_eq(r["role"], "link", f'"{r["text"]}" role')
                assert r["linkText"], f'"{r["text"]}" missing linkText'
            print(f"      verified {len(results)} links with linkText locators")

        section("Site 2: herokuapp — Tables")

        with test("navigate to tables page"):
            page.goto("https://the-internet.herokuapp.com/tables", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)
            screenshot(page, "07-heroku-tables")

        with test("table action links: role=link"):
            actions = page.evaluate("""() => {
                const links = document.querySelectorAll('#table1 td a');
                const out = [];
                for (let i = 0; i < Math.min(links.length, 4); i++) {
                    const info = window.__webcure.inspectElement(links[i], 'click');
                    out.push({ text: info.text, role: info.role, description: info.description });
                }
                return out;
            }""")
            assert len(actions) > 0
            for a in actions:
                assert_eq(a["role"], "link", f'"{a["text"]}" role')
            print(f'      found {len(actions)} action links: {", ".join(a["text"] for a in actions)}')

        section("Site 2: herokuapp — Dynamic Elements")

        with test("navigate to add/remove elements"):
            page.goto("https://the-internet.herokuapp.com/add_remove_elements/", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)

        with test("Add Element button → role=button"):
            info = page.evaluate("""() => {
                const btn = document.querySelector('button[onclick]') || document.querySelector('button');
                return btn ? window.__webcure.inspectElement(btn, 'click') : null;
            }""")
            assert_eq(info["role"], "button", "role")
            print(f'      description: "{info["description"]}"')

        with test("dynamically added buttons detected after click"):
            page.click('button:has-text("Add Element")')
            page.click('button:has-text("Add Element")')
            page.click('button:has-text("Add Element")')
            page.wait_for_timeout(300)
            inject_engine(page, engine_js)
            btns = page.evaluate("""() => {
                const els = document.querySelectorAll('#elements button');
                return Array.from(els).map(b => {
                    const info = window.__webcure.inspectElement(b, 'click');
                    return { text: info.text, role: info.role };
                });
            }""")
            assert len(btns) >= 1, f"expected dynamic buttons, got {len(btns)}"
            for b in btns:
                assert_eq(b["role"], "button", "dynamic btn role")
            print(f"      {len(btns)} dynamic buttons detected, all role=button")

        section("Site 2: herokuapp — Headings")

        with test("navigate to WYSIWYG page"):
            page.goto("https://the-internet.herokuapp.com/tinymce", wait_until="domcontentloaded", timeout=30000)
            inject_engine(page, engine_js)
            screenshot(page, "08-heroku-wysiwyg")

        with test("h3 heading: role=heading, category=display"):
            info = page.evaluate("""() => {
                const h = document.querySelector('h3');
                return h ? window.__webcure.inspectElement(h, 'click') : null;
            }""")
            if info:
                assert_eq(info["role"], "heading", "role")
                assert_eq(info["category"], "display", "category")
                print(f'      text: "{info["text"]}"')

        page.close()

        # ═══════════════════════════════════════════════════════════════════
        # SITE 3: Radix UI Themes Playground
        # Modern React — portals, ARIA roles, custom components
        # ═══════════════════════════════════════════════════════════════════

        section("Site 3: Radix UI — Page Load & Buttons")
        page = context.new_page()

        with test("navigate to Radix UI Themes Playground"):
            page.goto("https://www.radix-ui.com/themes/playground", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(3000)  # React hydration
            inject_engine(page, engine_js)
            screenshot(page, "09-radix-playground")

        with test("identify buttons: role=button, category=actionable"):
            buttons = page.evaluate("""() => {
                const btns = document.querySelectorAll('button');
                const out = [];
                for (let i = 0; i < btns.length && out.length < 6; i++) {
                    const t = btns[i].textContent?.trim();
                    if (t && t.length < 30 && t.length > 0) {
                        const info = window.__webcure.inspectElement(btns[i], 'click');
                        if (info) out.push({ text: t, role: info.role, category: info.category });
                    }
                }
                return out;
            }""")
            assert len(buttons) > 0, "No buttons found"
            for btn in buttons:
                assert_eq(btn["role"], "button", f'"{btn["text"]}" role')
                assert_eq(btn["category"], "actionable", f'"{btn["text"]}" category')
            print(f'      verified {len(buttons)} buttons: {", ".join(b["text"] for b in buttons)}')

        section("Site 3: Radix UI — Select Component")

        with test("find and inspect Radix Select trigger"):
            info = page.evaluate("""() => {
                const triggers = document.querySelectorAll('[role="combobox"], button[aria-haspopup="listbox"]');
                for (const t of triggers) {
                    const text = t.textContent?.trim();
                    if (text) return window.__webcure.inspectElement(t, 'click');
                }
                return null;
            }""")
            if info:
                assert_one_of(info["role"], ["combobox", "button"], "trigger role")
                print(f'      text: "{info["text"]}", role: {info["role"]}, category: {info["category"]}')
                print(f'      description: "{info["description"]}"')
            else:
                print("      (no combobox triggers found — page structure may vary)")

        with test("open Select → inspect options with context"):
            trigger = page.locator('[role="combobox"]').first
            if trigger.count() > 0:
                trigger.click()
                page.wait_for_timeout(500)
                inject_engine(page, engine_js)
                screenshot(page, "10-radix-select-open")

                options = page.evaluate("""() => {
                    const opts = document.querySelectorAll('[role="option"]');
                    const out = [];
                    for (let i = 0; i < Math.min(opts.length, 5); i++) {
                        const t = opts[i].textContent?.trim();
                        if (t) {
                            const info = window.__webcure.inspectElement(opts[i], 'click');
                            out.push({
                                text: t, role: info?.role, category: info?.category,
                                description: info?.description,
                                containerRole: info?.context?.containerRole,
                                triggerLabel: info?.context?.triggerLabel
                            });
                        }
                    }
                    return out;
                }""")
                if options:
                    for o in options:
                        assert_eq(o["role"], "option", f'"{o["text"]}" role')
                        assert_eq(o["category"], "option", f'"{o["text"]}" category')
                    print(f'      {len(options)} options: {", ".join(o["text"] for o in options)}')
                    print(f'      container: {options[0]["containerRole"]}, trigger: "{options[0]["triggerLabel"]}"')
                    print(f'      description: "{options[0]["description"]}"')
                else:
                    print("      (no options visible)")
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
            else:
                print("      (no combobox trigger on page — skipped)")

        section("Site 3: Radix UI — Dropdown Menu")

        with test("open DropdownMenu → inspect menu items with trigger context"):
            # Try aria-haspopup="menu" or "Options" text
            trigger = page.locator('button[aria-haspopup="menu"]').first
            opened = False
            if trigger.count() > 0:
                trigger.click()
                opened = True
            else:
                opt_btn = page.locator('button:has-text("Options")').first
                if opt_btn.count() > 0:
                    opt_btn.click()
                    opened = True

            if opened:
                page.wait_for_timeout(500)
                inject_engine(page, engine_js)
                screenshot(page, "11-radix-menu-open")

                items = page.evaluate("""() => {
                    const mis = document.querySelectorAll('[role="menuitem"]');
                    const out = [];
                    for (let i = 0; i < Math.min(mis.length, 5); i++) {
                        const t = mis[i].textContent?.trim();
                        if (t) {
                            const info = window.__webcure.inspectElement(mis[i], 'click');
                            out.push({
                                text: t, role: info?.role, category: info?.category,
                                description: info?.description,
                                containerRole: info?.context?.containerRole,
                                triggerLabel: info?.context?.triggerLabel
                            });
                        }
                    }
                    return out;
                }""")
                if items:
                    for mi in items:
                        assert_eq(mi["role"], "menuitem", f'"{mi["text"]}" role')
                        assert_eq(mi["category"], "actionable", f'"{mi["text"]}" category')
                    print(f'      {len(items)} items: {", ".join(i["text"] for i in items)}')
                    print(f'      container: {items[0]["containerRole"]}, trigger: "{items[0]["triggerLabel"]}"')
                    print(f'      description: "{items[0]["description"]}"')
                else:
                    print("      (no menuitems found)")
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
            else:
                print("      (no menu trigger found — skipped)")

        section("Site 3: Radix UI — Tabs")

        with test("tab elements: role=tab, category=navigation"):
            tabs = page.evaluate("""() => {
                const t = document.querySelectorAll('[role="tab"]');
                const out = [];
                for (let i = 0; i < Math.min(t.length, 5); i++) {
                    const text = t[i].textContent?.trim();
                    if (text) {
                        const info = window.__webcure.inspectElement(t[i], 'click');
                        out.push({ text, role: info?.role, category: info?.category });
                    }
                }
                return out;
            }""")
            if tabs:
                for t in tabs:
                    assert_eq(t["role"], "tab", f'"{t["text"]}" role')
                    assert_eq(t["category"], "navigation", f'"{t["text"]}" category')
                print(f'      {len(tabs)} tabs: {", ".join(t["text"] for t in tabs)}')
            else:
                print("      (no tabs found)")

        section("Site 3: Radix UI — Nested Element Resolution")

        with test("nested span/svg inside button resolves to button"):
            result = page.evaluate("""() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const child = btn.querySelector('span, svg');
                    if (child && btn.textContent?.trim()) {
                        const resolved = window.__webcure.resolveInteractiveElement(child);
                        return {
                            childTag: child.tagName.toLowerCase(),
                            resolvedTag: resolved?.tagName?.toLowerCase(),
                            same: resolved === btn,
                            text: btn.textContent.trim().substring(0, 40)
                        };
                    }
                }
                return null;
            }""")
            if result:
                assert result["same"], "child should resolve to parent button"
                print(f'      <{result["childTag"]}> inside "{result["text"]}" → <{result["resolvedTag"]}> ✓')

        with test("SVG path inside button resolves to interactive ancestor"):
            result = page.evaluate("""() => {
                const svgs = document.querySelectorAll('button svg, a svg, [role="button"] svg');
                for (const svg of svgs) {
                    const path = svg.querySelector('path, circle, rect, line');
                    if (path) {
                        const resolved = window.__webcure.resolveInteractiveElement(path);
                        const role = resolved ? window.__webcure.resolveRole(resolved) : null;
                        return { pathTag: path.tagName, resolvedTag: resolved?.tagName?.toLowerCase(), role };
                    }
                }
                return null;
            }""")
            if result:
                assert_one_of(result["role"], ["button", "link", "menuitem", "tab", "option"], "resolved role")
                print(f'      SVG <{result["pathTag"]}> → <{result["resolvedTag"]}> [role="{result["role"]}"] ✓')

        # ─── Radix: Checkboxes ────────────────────────────────────────────

        section("Site 3: Radix UI — Checkboxes")

        with test("checkbox elements: role=checkbox, category=toggle"):
            results = page.evaluate("""() => {
                const cbs = document.querySelectorAll('[role="checkbox"]');
                const out = [];
                for (let i = 0; i < Math.min(cbs.length, 6); i++) {
                    const info = window.__webcure.inspectElement(cbs[i], 'click');
                    if (info) out.push({
                        role: info.role, category: info.category,
                        value: info.value, label: info.label
                    });
                }
                return out;
            }""")
            assert len(results) > 0, "No checkboxes found"
            for r in results:
                assert_eq(r["role"], "checkbox", "role")
                assert_eq(r["category"], "toggle", "category")
                assert_one_of(r["value"], ["checked", "unchecked"], "value")
            checked = sum(1 for r in results if r["value"] == "checked")
            unchecked = len(results) - checked
            print(f"      {len(results)} checkboxes: {checked} checked, {unchecked} unchecked")

        with test("labeled checkbox: 'Agree to Terms and Conditions'"):
            info = page.evaluate("""() => {
                const cbs = document.querySelectorAll('[role="checkbox"]');
                for (const cb of cbs) {
                    const name = cb.getAttribute('aria-label') || '';
                    if (name.includes('Agree to Terms')) {
                        return window.__webcure.inspectElement(cb, 'click');
                    }
                }
                return null;
            }""")
            if info:
                assert_eq(info["role"], "checkbox", "role")
                assert_in("Toggled", info["description"], "description")
                print(f'      label: "{info["label"]}", description: "{info["description"]}"')

        with test("disabled checkbox: detected correctly"):
            info = page.evaluate("""() => {
                const cbs = document.querySelectorAll('[role="checkbox"][disabled], button[role="checkbox"][disabled]');
                for (const cb of cbs) {
                    return window.__webcure.inspectElement(cb, 'click');
                }
                return null;
            }""")
            if info:
                assert_eq(info["role"], "checkbox", "role")
                print(f'      disabled checkbox found, value: {info["value"]}')

        # ─── Radix: Radio Buttons ─────────────────────────────────────────

        section("Site 3: Radix UI — Radio Buttons")

        with test("radio elements: role=radio, category=toggle"):
            results = page.evaluate("""() => {
                const radios = document.querySelectorAll('[role="radio"]');
                const out = [];
                for (let i = 0; i < Math.min(radios.length, 8); i++) {
                    const info = window.__webcure.inspectElement(radios[i], 'click');
                    if (info) out.push({
                        role: info.role, category: info.category,
                        value: info.value, label: info.label
                    });
                }
                return out;
            }""")
            assert len(results) > 0, "No radios found"
            for r in results:
                assert_eq(r["role"], "radio", "role")
                assert_eq(r["category"], "toggle", "category")
            labels = [r["label"] for r in results if r["label"]]
            print(f"      {len(results)} radios, labels: {', '.join(labels[:5])}")

        with test("named radio: 'Light' appearance"):
            info = page.evaluate("""() => {
                const radios = document.querySelectorAll('[role="radio"]');
                for (const r of radios) {
                    const label = r.getAttribute('aria-label') || r.textContent?.trim() || '';
                    if (label === 'Light') return window.__webcure.inspectElement(r, 'click');
                }
                return null;
            }""")
            if info:
                assert_eq(info["role"], "radio", "role")
                assert_in("Toggled", info["description"], "description")
                print(f'      description: "{info["description"]}"')

        # ─── Radix: Text Inputs ───────────────────────────────────────────

        section("Site 3: Radix UI — Text Fields & Text Areas")

        with test("text input (email): role=textbox, category=input"):
            info = page.evaluate("""() => {
                const inputs = document.querySelectorAll('input[type="text"], input[placeholder]');
                for (const inp of inputs) {
                    const ph = inp.getAttribute('placeholder') || '';
                    if (ph.toLowerCase().includes('email')) {
                        return window.__webcure.inspectElement(inp, 'click');
                    }
                }
                return null;
            }""")
            if info:
                assert_eq(info["role"], "textbox", "role")
                assert_eq(info["category"], "input", "category")
                strategies = [l["strategy"] for l in info["locators"]]
                print(f'      label: "{info["label"]}", locators: {", ".join(strategies)}')
            else:
                print("      (no email input found)")

        with test("type into email field → description"):
            info = page.evaluate("""() => {
                const inputs = document.querySelectorAll('input[placeholder]');
                for (const inp of inputs) {
                    const ph = inp.getAttribute('placeholder') || '';
                    if (ph.toLowerCase().includes('email')) {
                        return window.__webcure.inspectElement(inp, 'type', { value: 'test@example.com' });
                    }
                }
                return null;
            }""")
            if info:
                assert_in("Typed", info["description"], "description")
                assert_in("test@example.com", info["description"], "value")
                print(f'      description: "{info["description"]}"')

        with test("textarea: role=textbox, category=input"):
            info = page.evaluate("""() => {
                const ta = document.querySelector('textarea');
                return ta ? window.__webcure.inspectElement(ta, 'click') : null;
            }""")
            if info:
                assert_eq(info["role"], "textbox", "role")
                assert_eq(info["category"], "input", "category")
                print(f'      label: "{info["label"]}"')
            else:
                print("      (no textarea found)")

        # ─── Radix: Switch ────────────────────────────────────────────────

        section("Site 3: Radix UI — Switch")

        with test("switch elements: role=switch, category=toggle"):
            results = page.evaluate("""() => {
                const sws = document.querySelectorAll('[role="switch"]');
                const out = [];
                for (let i = 0; i < Math.min(sws.length, 4); i++) {
                    const info = window.__webcure.inspectElement(sws[i], 'click');
                    if (info) out.push({ role: info.role, category: info.category, value: info.value });
                }
                return out;
            }""")
            if results:
                for r in results:
                    assert_eq(r["role"], "switch", "role")
                    assert_eq(r["category"], "toggle", "category")
                print(f"      {len(results)} switches found")
            else:
                print("      (no switches found on visible page)")

        # ─── Radix: Slider ────────────────────────────────────────────────

        section("Site 3: Radix UI — Slider")

        with test("slider: role=slider"):
            info = page.evaluate("""() => {
                const s = document.querySelector('[role="slider"]');
                return s ? window.__webcure.inspectElement(s, 'click') : null;
            }""")
            if info:
                assert_eq(info["role"], "slider", "role")
                print(f'      value: "{info["value"]}"')
            else:
                print("      (no slider visible — may need scroll)")

        # ─── Radix: Links ─────────────────────────────────────────────────

        section("Site 3: Radix UI — Links & Navigation")

        with test("page navigation links: role=link, category=actionable"):
            results = page.evaluate("""() => {
                const links = document.querySelectorAll('nav a[href], header a[href]');
                const out = [];
                for (let i = 0; i < Math.min(links.length, 6); i++) {
                    const text = links[i].textContent?.trim();
                    if (text) {
                        const info = window.__webcure.inspectElement(links[i], 'click');
                        out.push({ text, role: info?.role, category: info?.category });
                    }
                }
                return out;
            }""")
            assert len(results) > 0, "No nav links found"
            for r in results:
                assert_eq(r["role"], "link", f'"{r["text"]}" role')
                assert_eq(r["category"], "actionable", f'"{r["text"]}" category')
            print(f'      {len(results)} nav links: {", ".join(r["text"] for r in results)}')

        with test("'View in docs' links: correct role and linkText locator"):
            results = page.evaluate("""() => {
                const links = document.querySelectorAll('a');
                const out = [];
                for (const link of links) {
                    if ((link.textContent?.trim() || '') === 'View in docs' && out.length < 3) {
                        const info = window.__webcure.inspectElement(link, 'click');
                        const lt = info?.locators?.find(l => l.strategy === 'linkText');
                        out.push({ role: info?.role, linkText: lt?.value, href: link.getAttribute('href') });
                    }
                }
                return out;
            }""")
            assert len(results) > 0, "No 'View in docs' links found"
            for r in results:
                assert_eq(r["role"], "link", "role")
                assert_eq(r["linkText"], "View in docs", "linkText")
            print(f'      {len(results)} "View in docs" links verified with linkText locator')

        # ─── Radix: Headings ──────────────────────────────────────────────

        section("Site 3: Radix UI — Headings")

        with test("component headings: role=heading, category=display"):
            results = page.evaluate("""() => {
                const hs = document.querySelectorAll('h1, h2, h3');
                const out = [];
                const seen = new Set();
                for (const h of hs) {
                    const text = h.textContent?.trim()?.substring(0, 30);
                    if (text && !seen.has(text) && out.length < 6) {
                        seen.add(text);
                        const info = window.__webcure.inspectElement(h, 'click');
                        out.push({ text, role: info?.role, category: info?.category });
                    }
                }
                return out;
            }""")
            assert len(results) > 0, "No headings found"
            for r in results:
                assert_eq(r["role"], "heading", f'"{r["text"]}" role')
                assert_eq(r["category"], "display", f'"{r["text"]}" category')
            print(f'      {len(results)} headings: {", ".join(r["text"] for r in results)}')

        # ─── Radix: Disabled Buttons ──────────────────────────────────────

        section("Site 3: Radix UI — Disabled Elements")

        with test("disabled buttons still identified as role=button"):
            results = page.evaluate("""() => {
                const btns = document.querySelectorAll('button[disabled]');
                const out = [];
                for (let i = 0; i < Math.min(btns.length, 4); i++) {
                    const text = btns[i].textContent?.trim()?.substring(0, 20);
                    const info = window.__webcure.inspectElement(btns[i], 'click');
                    out.push({ text, role: info?.role, category: info?.category });
                }
                return out;
            }""")
            if results:
                for r in results:
                    assert_eq(r["role"], "button", f'disabled "{r["text"]}" role')
                    assert_eq(r["category"], "actionable", f'disabled "{r["text"]}" category')
                print(f'      {len(results)} disabled buttons, all correctly identified as role=button')
            else:
                print("      (no disabled buttons visible)")

        # ─── Radix: Dialog Portal ─────────────────────────────────────────

        section("Site 3: Radix UI — Alert Dialog (Portal)")

        with test("open Alert Dialog → portal has role=alertdialog, category=container"):
            trigger = page.locator('button:has-text("Open")').first
            if trigger.count() > 0:
                trigger.scroll_into_view_if_needed()
                trigger.click()
                page.wait_for_timeout(500)
                inject_engine(page, engine_js)
                screenshot(page, "13-radix-alert-dialog")

                info = page.evaluate("""() => {
                    const d = document.querySelector('[role="alertdialog"]');
                    return d ? window.__webcure.inspectElement(d, 'click') : null;
                }""")
                if info:
                    assert_eq(info["role"], "alertdialog", "role")
                    assert_eq(info["category"], "container", "category")
                    print(f'      alertdialog detected, category: {info["category"]}')

                # Test button inside dialog
                btn_info = page.evaluate("""() => {
                    const d = document.querySelector('[role="alertdialog"]');
                    if (!d) return null;
                    const btn = d.querySelector('button');
                    if (!btn) return null;
                    const info = window.__webcure.inspectElement(btn, 'click');
                    return { text: info?.text, role: info?.role, containerRole: info?.context?.containerRole };
                }""")
                if btn_info:
                    assert_eq(btn_info["role"], "button", "button in dialog role")
                    print(f'      button "{btn_info["text"]}" in container: {btn_info["containerRole"]}')

                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
            else:
                print("      (no Open button found)")

        # ─── Radix: Progress ──────────────────────────────────────────────

        section("Site 3: Radix UI — Progress Bar")

        with test("progress bar: role=progressbar, category=display"):
            info = page.evaluate("""() => {
                const p = document.querySelector('[role="progressbar"]');
                return p ? window.__webcure.inspectElement(p, 'click') : null;
            }""")
            if info:
                assert_eq(info["role"], "progressbar", "role")
                assert_eq(info["category"], "display", "category")
                print(f'      value: "{info["value"]}"')
            else:
                print("      (no progressbar visible — may be below fold)")

        # ─── Radix: Tabpanel ──────────────────────────────────────────────

        section("Site 3: Radix UI — Tabpanel")

        with test("tabpanel: role=tabpanel, category=container"):
            info = page.evaluate("""() => {
                const p = document.querySelector('[role="tabpanel"]');
                return p ? window.__webcure.inspectElement(p, 'click') : null;
            }""")
            if info:
                assert_eq(info["role"], "tabpanel", "role")
                assert_eq(info["category"], "container", "category")
                print(f'      tabpanel label: "{info["label"]}"')

        # ─── Radix: Separator ─────────────────────────────────────────────

        section("Site 3: Radix UI — Separator & Display Elements")

        with test("separator has role=separator"):
            info = page.evaluate("""() => {
                const s = document.querySelector('[role="separator"]');
                return s ? window.__webcure.inspectElement(s, 'click') : null;
            }""")
            if info:
                assert_eq(info["role"], "separator", "role")
                print(f"      separator found, category: {info['category']}")
            else:
                print("      (no separator with role attribute)")

        with test("images: role=img, category=display"):
            results = page.evaluate("""() => {
                const imgs = document.querySelectorAll('img[alt]');
                const out = [];
                for (let i = 0; i < Math.min(imgs.length, 3); i++) {
                    const alt = imgs[i].getAttribute('alt');
                    if (alt) {
                        const info = window.__webcure.inspectElement(imgs[i], 'click');
                        out.push({ alt, role: info?.role, category: info?.category });
                    }
                }
                return out;
            }""")
            if results:
                for r in results:
                    assert_eq(r["role"], "img", f'"{r["alt"][:20]}" role')
                    assert_eq(r["category"], "display", f'"{r["alt"][:20]}" category')
                print(f'      {len(results)} images with alt text, all role=img')
            else:
                print("      (no images with alt attribute found)")

        # ─── Radix: Locator Quality ───────────────────────────────────────

        section("Site 3: Radix UI — Locator Quality")

        with test("Sign in button: multiple locator strategies"):
            info = page.evaluate("""() => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    if ((btn.textContent?.trim() || '') === 'Sign in') {
                        return window.__webcure.inspectElement(btn, 'click');
                    }
                }
                return null;
            }""")
            if info:
                strategies = [l["strategy"] for l in info["locators"]]
                assert len(strategies) >= 2, f"expected ≥2 locator strategies, got {strategies}"
                print(f'      "Sign in" button locators: {", ".join(strategies)}')
                for loc in info["locators"]:
                    print(f'        {loc["strategy"]}: {loc["value"]}')

        with test("locators sorted by confidence (highest first)"):
            info = page.evaluate("""() => {
                const el = document.querySelector('input[placeholder]') || document.querySelector('button');
                return window.__webcure.inspectElement(el, 'click');
            }""")
            if info and info["locators"]:
                confidences = [l["confidence"] for l in info["locators"]]
                for i in range(1, len(confidences)):
                    assert confidences[i] <= confidences[i-1], \
                        f"locators not sorted: {confidences[i-1]} > {confidences[i]}"
                print(f"      confidences: {confidences}")

        # ─── Radix: Accessible Name ───────────────────────────────────────

        section("Site 3: Radix UI — Accessible Name Computation")

        with test("inputs with placeholder derive accessible name"):
            results = page.evaluate("""() => {
                const inputs = document.querySelectorAll('input[placeholder]');
                const out = [];
                for (let i = 0; i < Math.min(inputs.length, 3); i++) {
                    const info = window.__webcure.inspectElement(inputs[i], 'click');
                    out.push({ placeholder: inputs[i].getAttribute('placeholder'), name: info?.text, label: info?.label });
                }
                return out;
            }""")
            for r in results:
                assert r["label"] or r["name"], f"no accessible name for placeholder '{r['placeholder']}'"
                print(f'      placeholder: "{r["placeholder"]}" → label: "{r["label"]}"')

        with test("aria-labeled checkboxes have correct accessible names"):
            results = page.evaluate("""() => {
                const cbs = document.querySelectorAll('[role="checkbox"][aria-label]');
                const out = [];
                for (let i = 0; i < Math.min(cbs.length, 3); i++) {
                    const al = cbs[i].getAttribute('aria-label');
                    const info = window.__webcure.inspectElement(cbs[i], 'click');
                    out.push({ ariaLabel: al, name: info?.text, label: info?.label });
                }
                return out;
            }""")
            for r in results:
                if r["ariaLabel"]:
                    assert r["name"] or r["label"], f"no name for aria-label '{r['ariaLabel']}'"
                    print(f'      aria-label: "{r["ariaLabel"]}" → name: "{r["name"]}"')

        # ─── Radix: Table Structures ──────────────────────────────────────

        section("Site 3: Radix UI — Table Structures")

        with test("table element: role=table"):
            info = page.evaluate("""() => {
                const t = document.querySelector('table');
                return t ? window.__webcure.inspectElement(t, 'click') : null;
            }""")
            if info:
                assert_eq(info["role"], "table", "role")
                print(f'      table found, category: {info["category"]}')

        with test("interactive elements inside table cells correctly identified"):
            results = page.evaluate("""() => {
                const cells = document.querySelectorAll('td');
                const out = [];
                for (const cell of cells) {
                    const btn = cell.querySelector('button');
                    if (btn && out.length < 3) {
                        const info = window.__webcure.inspectElement(btn, 'click');
                        out.push({ text: info?.text?.substring(0, 20), role: info?.role, category: info?.category });
                    }
                }
                return out;
            }""")
            if results:
                for r in results:
                    assert_eq(r["role"], "button", f'button in cell role')
                print(f'      {len(results)} buttons inside table cells, all role=button')

        page.close()

        # ═══════════════════════════════════════════════════════════════════
        # SITE 4: W3C WAI-ARIA Practices — Reference Implementations
        # ═══════════════════════════════════════════════════════════════════

        section("Site 4: W3C WAI-ARIA Practices — Tabs Example")
        page = context.new_page()

        with test("navigate to WAI-ARIA tabs example"):
            page.goto("https://www.w3.org/WAI/ARIA/apg/patterns/tabs/examples/tabs-automatic/",
                       wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(1000)
            inject_engine(page, engine_js)
            screenshot(page, "12-w3c-tabs")

        with test("reference tabs: role=tab, category=navigation"):
            tabs = page.evaluate("""() => {
                const t = document.querySelectorAll('[role="tab"]');
                const out = [];
                for (const el of t) {
                    const info = window.__webcure.inspectElement(el, 'click');
                    if (info) out.push({
                        text: info.text, role: info.role,
                        category: info.category, description: info.description
                    });
                }
                return out;
            }""")
            if tabs:
                for t in tabs:
                    assert_eq(t["role"], "tab", f'"{t["text"]}" role')
                    assert_eq(t["category"], "navigation", f'"{t["text"]}" category')
                print(f'      {len(tabs)} tabs: {", ".join(t["text"] for t in tabs)}')
                print(f'      description: "{tabs[0]["description"]}"')

        with test("tabpanel: role=tabpanel, category=container"):
            info = page.evaluate("""() => {
                const p = document.querySelector('[role="tabpanel"]');
                return p ? window.__webcure.inspectElement(p, 'click') : null;
            }""")
            if info:
                assert_eq(info["role"], "tabpanel", "role")
                assert_eq(info["category"], "container", "category")
                print(f"      tabpanel found, category: {info['category']}")

        page.close()

        # ═══════════════════════════════════════════════════════════════════
        # CLEANUP & SUMMARY
        # ═══════════════════════════════════════════════════════════════════

        browser.close()

    print("\n\033[1m══════════════════════════════════════════════════════════════\033[0m")
    print("\033[1m  Results Summary — Live Browser Integration Tests (Python)\033[0m")
    print("\033[1m══════════════════════════════════════════════════════════════\033[0m")

    for name, r in section_results.items():
        status = "\033[32m✓\033[0m" if r["fail"] == 0 else "\033[31m✗\033[0m"
        print(f'  {status} {name}: {r["pass"]} passed, {r["fail"]} failed')

    print(f'\n  \033[1mTotal: {pass_count} passed, {fail_count} failed\033[0m')

    if failures:
        print(f"\n  \033[31mFailures:\033[0m")
        for i, f in enumerate(failures, 1):
            print(f"    {i}. {f}")

    # List screenshots
    shots = sorted(SCREENSHOT_DIR.glob("*.png"))
    if shots:
        print(f"\n  \033[1mScreenshots ({len(shots)}):\033[0m {SCREENSHOT_DIR}/")
        for s in shots:
            print(f"    {s.name}")

    print()
    sys.exit(1 if fail_count > 0 else 0)


if __name__ == "__main__":
    main()
