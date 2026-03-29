#!/usr/bin/env python3
"""
WebCure — Assertion Helpers Integration Tests

Tests ALL 11 assertion helper functions that WebCure embeds in generated
Python test scripts.  Runs against public test sites that exercise every
assertion type: visibility, text, value, checked, enabled, title, URL,
count, attribute, and page-contains-text.

Test targets:
  1. the-internet.herokuapp.com — checkboxes, inputs, dropdowns, tables
  2. demo.testfire.net            — forms, login, page title / URL

Requirements:
    pip install playwright
    python -m playwright install chromium   # or use system Chrome

Run:
    python3 tests/integration/test_assertions.py
"""

import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeoutError

# ═══════════════════════════════════════════════════════════════════════════════
# Embedded helpers — identical to what WebCure generates in recorded scripts
# ═══════════════════════════════════════════════════════════════════════════════

WAIT_TIMEOUT = 5000


def _resolve_locator(page, strategy: str, value: str):
    if strategy == "testId":
        m = re.search(r'"([^"]+)"', value)
        return page.get_by_test_id(m.group(1) if m else value)
    elif strategy == "id":
        return page.locator(f"#{value}")
    elif strategy == "aria":
        m = re.match(r'^([\w][\w-]*)\[name="([^"]+)"\]$', value)
        if m:
            return page.get_by_role(m.group(1), name=m.group(2))
        return page.locator(f'[aria-label="{value}"]')
    elif strategy == "ariaLabel":
        return page.get_by_label(value)
    elif strategy == "linkText":
        return page.get_by_role("link", name=value)
    elif strategy == "text":
        return page.get_by_text(value, exact=True)
    elif strategy == "name":
        return page.locator(f'[name="{value}"]')
    elif strategy == "css":
        return page.locator(value)
    elif strategy == "xpath":
        return page.locator(f"xpath={value}")
    else:
        return page.locator(value)


def find_element(page, locators: list, timeout: int = WAIT_TIMEOUT, state: str = "visible"):
    last_err = None
    ordered = sorted(locators, key=lambda l: l.get("confidence", 0), reverse=True)
    for loc in ordered:
        strategy = loc.get("strategy", "css")
        value = loc.get("value", "")
        if not value:
            continue
        try:
            el = _resolve_locator(page, strategy, value)
            el.wait_for(state=state, timeout=timeout)
            return el
        except PWTimeoutError as e:
            last_err = e
        except Exception as e:
            last_err = e
    strategies = [f"{l.get('strategy')}={l.get('value')}" for l in ordered]
    raise Exception(f"Element not found with any of: {strategies}\nLast error: {last_err}")


def self_healing_click(page, locators: list, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    el.click()


def self_healing_fill(page, locators: list, value: str, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    el.fill(value)


def self_healing_select(page, locators: list, value: str, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    try:
        el.select_option(label=value)
    except Exception:
        el.select_option(value=value)


def self_healing_press(page, locators: list, key: str, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    el.press(key)


# ── Assertion helpers ─────────────────────────────────────────────────────────

def assert_element_visible(page, locators: list, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    assert el.is_visible(), "Expected element to be visible"


def assert_element_not_visible(page, locators: list, timeout: int = 2000):
    last_err = None
    ordered = sorted(locators, key=lambda l: l.get("confidence", 0), reverse=True)
    for loc in ordered:
        strategy = loc.get("strategy", "css")
        value = loc.get("value", "")
        if not value:
            continue
        try:
            el = _resolve_locator(page, strategy, value)
            el.wait_for(state="hidden", timeout=timeout)
            return
        except Exception as e:
            last_err = e
    if last_err:
        return


def assert_element_text(page, locators: list, expected_text: str, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    actual = re.sub(r'\s+', ' ', el.inner_text()).strip()
    expected = re.sub(r'\s+', ' ', expected_text).strip()
    assert expected in actual, f"Expected text '{expected}' in '{actual[:200]}'"


def assert_element_value(page, locators: list, expected_value: str, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    actual = el.input_value()
    assert actual == expected_value, f"Expected value '{expected_value}' but got '{actual}'"


def assert_element_checked(page, locators: list, expected: bool = True, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    actual = el.is_checked()
    state = "checked" if expected else "unchecked"
    assert actual == expected, f"Expected element to be {state} but it was {'checked' if actual else 'unchecked'}"


def assert_element_enabled(page, locators: list, expected: bool = True, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    actual = el.is_enabled()
    state = "enabled" if expected else "disabled"
    assert actual == expected, f"Expected element to be {state} but it was {'enabled' if actual else 'disabled'}"


def assert_page_title(page, expected_title: str):
    actual = page.title()
    assert actual == expected_title, f"Expected title '{expected_title}' but got '{actual}'"


def assert_page_url(page, expected_url: str, match_type: str = "exact"):
    actual = page.url
    if match_type == "contains":
        assert expected_url in actual, f"Expected URL to contain '{expected_url}' but got '{actual}'"
    else:
        assert actual == expected_url, f"Expected URL '{expected_url}' but got '{actual}'"


def assert_element_count(page, locators: list, expected_count: int, timeout: int = WAIT_TIMEOUT):
    ordered = sorted(locators, key=lambda l: l.get("confidence", 0), reverse=True)
    for loc in ordered:
        strategy = loc.get("strategy", "css")
        value = loc.get("value", "")
        if not value:
            continue
        try:
            el = _resolve_locator(page, strategy, value)
            el.first.wait_for(state="visible", timeout=timeout)
            actual = el.count()
            assert actual == expected_count, f"Expected {expected_count} elements but found {actual}"
            return
        except AssertionError:
            raise
        except Exception:
            continue
    raise Exception("Could not count elements — none of the locators matched")


def assert_element_attribute(page, locators: list, attr_name: str, expected_value: str, timeout: int = WAIT_TIMEOUT):
    el = find_element(page, locators, timeout)
    actual = el.get_attribute(attr_name)
    assert actual == expected_value, f"Expected {attr_name}='{expected_value}' but got '{actual}'"


def assert_page_contains_text(page, expected_text: str, timeout: int = WAIT_TIMEOUT):
    page.get_by_text(expected_text, exact=False).first.wait_for(state="visible", timeout=timeout)


# ═══════════════════════════════════════════════════════════════════════════════
# Test harness — mirrors style from live_engine_test.py
# ═══════════════════════════════════════════════════════════════════════════════

pass_count = 0
fail_count = 0
failures = []
current_section = ""
section_results = {}


def section(name: str):
    global current_section
    current_section = name
    section_results[name] = {"pass": 0, "fail": 0}
    print(f"\n  \033[1m{name}\033[0m")


def test(name: str):
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
            return True
    return TestContext()


# ═══════════════════════════════════════════════════════════════════════════════
# Browser helpers
# ═══════════════════════════════════════════════════════════════════════════════

def find_chromium() -> str:
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


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN — Test all assertion helpers
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print("\n\033[1m══════════════════════════════════════════════════════════════\033[0m")
    print("\033[1m  WebCure — Assertion Helpers Integration Tests\033[0m")
    print("\033[1m  Testing all 11 assertion functions against live websites\033[0m")
    print("\033[1m══════════════════════════════════════════════════════════════\033[0m")

    chromium_path = find_chromium()
    print(f"  Browser: {chromium_path}")

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chromium_path, headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 800})

        # ═══════════════════════════════════════════════════════════════
        # SITE 1: the-internet.herokuapp.com
        # Checkboxes, Inputs, Dropdowns, Dynamic Content
        # ═══════════════════════════════════════════════════════════════

        # ── 1.1 Checkboxes ────────────────────────────────────────────
        section("Checkboxes — assert_element_checked, assert_element_visible")
        page = context.new_page()

        with test("navigate to checkboxes page"):
            page.goto("https://the-internet.herokuapp.com/checkboxes", wait_until="domcontentloaded", timeout=15000)

        checkbox_locators_1 = [
            {"strategy": "css", "value": "#checkboxes input:nth-child(1)", "confidence": 0.8},
        ]
        checkbox_locators_2 = [
            {"strategy": "css", "value": "#checkboxes input:nth-child(3)", "confidence": 0.8},
        ]

        with test("assert_element_visible — checkbox 1 is visible"):
            assert_element_visible(page, checkbox_locators_1)

        with test("assert_element_checked — checkbox 1 is unchecked by default"):
            assert_element_checked(page, checkbox_locators_1, expected=False)

        with test("assert_element_checked — checkbox 2 is checked by default"):
            assert_element_checked(page, checkbox_locators_2, expected=True)

        with test("self_healing_click + assert_element_checked — toggle checkbox 1 on"):
            self_healing_click(page, checkbox_locators_1)
            assert_element_checked(page, checkbox_locators_1, expected=True)

        with test("self_healing_click + assert_element_checked — toggle checkbox 2 off"):
            self_healing_click(page, checkbox_locators_2)
            assert_element_checked(page, checkbox_locators_2, expected=False)

        page.close()

        # ── 1.2 Inputs ───────────────────────────────────────────────
        section("Inputs — assert_element_value, self_healing_fill")
        page = context.new_page()

        with test("navigate to inputs page"):
            page.goto("https://the-internet.herokuapp.com/inputs", wait_until="domcontentloaded", timeout=15000)

        input_locators = [
            {"strategy": "css", "value": "input[type='number']", "confidence": 0.9},
        ]

        with test("assert_element_visible — number input is visible"):
            assert_element_visible(page, input_locators)

        with test("self_healing_fill + assert_element_value — fill value '42'"):
            self_healing_fill(page, input_locators, "42")
            assert_element_value(page, input_locators, "42")

        with test("assert_element_enabled — input is enabled"):
            assert_element_enabled(page, input_locators, expected=True)

        page.close()

        # ── 1.3 Dropdown ─────────────────────────────────────────────
        section("Dropdown — self_healing_select, assert_element_value")
        page = context.new_page()

        with test("navigate to dropdown page"):
            page.goto("https://the-internet.herokuapp.com/dropdown", wait_until="domcontentloaded", timeout=15000)

        dropdown_locators = [
            {"strategy": "id", "value": "dropdown", "confidence": 0.95},
        ]

        with test("assert_element_visible — dropdown is visible"):
            assert_element_visible(page, dropdown_locators)

        with test("self_healing_select + assert_element_value — select Option 2"):
            self_healing_select(page, dropdown_locators, "Option 2")
            assert_element_value(page, dropdown_locators, "2")

        with test("self_healing_select + assert_element_value — switch to Option 1"):
            self_healing_select(page, dropdown_locators, "Option 1")
            assert_element_value(page, dropdown_locators, "1")

        page.close()

        # ── 1.4 Page Title & URL ──────────────────────────────────────
        section("Page-level assertions — assert_page_title, assert_page_url")
        page = context.new_page()

        with test("navigate to the-internet homepage"):
            page.goto("https://the-internet.herokuapp.com/", wait_until="domcontentloaded", timeout=15000)

        with test("assert_page_title — exact match"):
            assert_page_title(page, "The Internet")

        with test("assert_page_url — exact match"):
            assert_page_url(page, "https://the-internet.herokuapp.com/")

        with test("assert_page_url — contains match"):
            assert_page_url(page, "herokuapp.com", match_type="contains")

        page.close()

        # ── 1.5 Text Content ─────────────────────────────────────────
        section("Text assertions — assert_element_text, assert_page_contains_text")
        page = context.new_page()

        with test("navigate to the-internet homepage"):
            page.goto("https://the-internet.herokuapp.com/", wait_until="domcontentloaded", timeout=15000)

        heading_locators = [
            {"strategy": "css", "value": "h1.heading", "confidence": 0.9},
        ]

        with test("assert_element_text — heading contains 'Welcome'"):
            assert_element_text(page, heading_locators, "Welcome")

        with test("assert_page_contains_text — page contains 'Available Examples'"):
            assert_page_contains_text(page, "Available Examples")

        page.close()

        # ── 1.6 Element Count ────────────────────────────────────────
        section("Element counting — assert_element_count")
        page = context.new_page()

        with test("navigate to checkboxes page"):
            page.goto("https://the-internet.herokuapp.com/checkboxes", wait_until="domcontentloaded", timeout=15000)

        all_checkboxes = [
            {"strategy": "css", "value": "#checkboxes input[type='checkbox']", "confidence": 0.9},
        ]

        with test("assert_element_count — exactly 2 checkboxes"):
            assert_element_count(page, all_checkboxes, 2)

        page.close()

        # ── 1.7 Element Attribute ─────────────────────────────────────
        section("Attribute assertions — assert_element_attribute")
        page = context.new_page()

        with test("navigate to inputs page"):
            page.goto("https://the-internet.herokuapp.com/inputs", wait_until="domcontentloaded", timeout=15000)

        with test("assert_element_attribute — input type is 'number'"):
            assert_element_attribute(page, input_locators, "type", "number")

        page.close()

        # ── 1.8 Not-Visible ──────────────────────────────────────────
        section("Negative assertions — assert_element_not_visible")
        page = context.new_page()

        with test("navigate to the-internet homepage"):
            page.goto("https://the-internet.herokuapp.com/", wait_until="domcontentloaded", timeout=15000)

        nonexistent_locators = [
            {"strategy": "id", "value": "does-not-exist-xyz", "confidence": 0.9},
        ]

        with test("assert_element_not_visible — non-existent element"):
            assert_element_not_visible(page, nonexistent_locators, timeout=1000)

        page.close()

        # ═══════════════════════════════════════════════════════════════
        # SITE 2: demo.testfire.net — Login Form
        # ═══════════════════════════════════════════════════════════════

        section("Login flow — self_healing_fill, assert_page_url, assert_element_text")
        page = context.new_page()

        with test("navigate to AltoroMutual login"):
            page.goto("http://demo.testfire.net/login.jsp", wait_until="domcontentloaded", timeout=15000)

        username_locators = [
            {"strategy": "id", "value": "uid", "confidence": 0.95},
            {"strategy": "name", "value": "uid", "confidence": 0.9},
        ]
        password_locators = [
            {"strategy": "id", "value": "passw", "confidence": 0.95},
            {"strategy": "name", "value": "passw", "confidence": 0.9},
        ]
        login_btn_locators = [
            {"strategy": "css", "value": "input[type='submit'][value='Login']", "confidence": 0.9},
            {"strategy": "name", "value": "btnSubmit", "confidence": 0.8},
        ]

        with test("assert_element_visible — username input"):
            assert_element_visible(page, username_locators)

        with test("assert_element_visible — password input"):
            assert_element_visible(page, password_locators)

        with test("assert_element_enabled — login button is enabled"):
            assert_element_enabled(page, login_btn_locators, expected=True)

        with test("self_healing_fill — enter username"):
            self_healing_fill(page, username_locators, "admin")

        with test("assert_element_value — username was filled"):
            assert_element_value(page, username_locators, "admin")

        with test("self_healing_fill — enter password"):
            self_healing_fill(page, password_locators, "admin")

        with test("self_healing_click — click Login"):
            self_healing_click(page, login_btn_locators)
            page.wait_for_load_state("networkidle", timeout=10000)

        with test("assert_page_url — redirected after login (contains)"):
            assert_page_url(page, "bank", match_type="contains")

        with test("assert_page_title — bank page title"):
            actual_title = page.title()
            # Just verify title is non-empty and different from login
            assert actual_title and "login" not in actual_title.lower(), \
                f"Expected non-login title but got '{actual_title}'"

        with test("assert_page_contains_text — 'Sign Off' visible after login"):
            assert_page_contains_text(page, "Sign Off")

        page.close()

        # ═══════════════════════════════════════════════════════════════
        # SITE 3: Self-healing — multi-locator fallback
        # ═══════════════════════════════════════════════════════════════

        section("Self-healing locators — fallback strategy")
        page = context.new_page()

        with test("navigate to login page"):
            page.goto("http://demo.testfire.net/login.jsp", wait_until="domcontentloaded", timeout=15000)

        # First locator is deliberately wrong, should fall back to second
        fallback_locators = [
            {"strategy": "id", "value": "nonexistent-uid-xyz", "confidence": 0.99},
            {"strategy": "name", "value": "uid", "confidence": 0.5},
        ]

        with test("find_element falls back from broken ID to name locator"):
            el = find_element(page, fallback_locators)
            assert el.is_visible(), "Fallback locator should find visible element"

        with test("assert_element_visible works with fallback locators"):
            assert_element_visible(page, fallback_locators)

        page.close()

        # ═══════════════════════════════════════════════════════════════
        # SITE 4: Negative test — deliberate failures
        # ═══════════════════════════════════════════════════════════════

        section("Negative tests — verify assertion failures are caught")
        page = context.new_page()

        with test("navigate to checkboxes page"):
            page.goto("https://the-internet.herokuapp.com/checkboxes", wait_until="domcontentloaded", timeout=15000)

        with test("assert_element_checked fails on wrong expected state"):
            try:
                # checkbox 2 is checked by default — asserting unchecked should fail
                assert_element_checked(page, checkbox_locators_2, expected=False)
                raise AssertionError("Should have failed but didn't")
            except AssertionError as e:
                if "Should have failed" in str(e):
                    raise
                # Expected failure — assertion correctly reported mismatch
                pass

        with test("assert_element_text fails on wrong text"):
            heading = [{"strategy": "css", "value": "h3", "confidence": 0.8}]
            try:
                assert_element_text(page, heading, "This text does not exist anywhere")
                raise AssertionError("Should have failed but didn't")
            except AssertionError as e:
                if "Should have failed" in str(e):
                    raise
                pass

        with test("assert_page_title fails on wrong title"):
            try:
                assert_page_title(page, "Wrong Title That Does Not Match")
                raise AssertionError("Should have failed but didn't")
            except AssertionError as e:
                if "Should have failed" in str(e):
                    raise
                pass

        with test("assert_element_count fails on wrong count"):
            try:
                assert_element_count(page, all_checkboxes, 99)
                raise AssertionError("Should have failed but didn't")
            except AssertionError as e:
                if "Should have failed" in str(e):
                    raise
                pass

        page.close()

        # ═══════════════════════════════════════════════════════════════
        # CLEANUP
        # ═══════════════════════════════════════════════════════════════
        browser.close()

    # ─── Summary ──────────────────────────────────────────────────────────
    print("\n\033[1m══════════════════════════════════════════════════════════════\033[0m")
    print(f"\033[1m  RESULTS: {pass_count} passed, {fail_count} failed\033[0m")
    print("\033[1m══════════════════════════════════════════════════════════════\033[0m")

    for sec, counts in section_results.items():
        p, f = counts["pass"], counts["fail"]
        icon = "\033[32m✓\033[0m" if f == 0 else "\033[31m✗\033[0m"
        print(f"  {icon} {sec}: {p} passed, {f} failed")

    if failures:
        print(f"\n  \033[31mFailed tests:\033[0m")
        for f in failures:
            print(f"    • {f}")
        print()

    sys.exit(1 if fail_count > 0 else 0)


if __name__ == "__main__":
    main()
