#!/usr/bin/env bash
# =============================================================================
# WebCure — Automated Bridge Integration Test Script
# =============================================================================
#
# Runs all file-bridge commands and validates responses.
#
# Prerequisites:
#   - VS Code running with webcure extension loaded
#   - A workspace folder open (the bridge creates .webcure/ in workspace root)
#
# Usage:
#   cd <workspace-root>
#   bash tests/bridge-integration-tests.sh
#
# The script writes commands to .webcure/input.json and reads .webcure/output.json.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BRIDGE_DIR=".webcure"
INPUT_FILE="$BRIDGE_DIR/input.json"
OUTPUT_FILE="$BRIDGE_DIR/output.json"
TEST_URL="https://the-internet.herokuapp.com"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL_COUNT=0
FAILURES=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()      { printf "\033[0;36m[INFO]\033[0m  %s\n" "$1"; }
log_pass() { printf "\033[0;32m[PASS]\033[0m  %s\n" "$1"; }
log_fail() { printf "\033[0;31m[FAIL]\033[0m  %s\n" "$1"; }
log_skip() { printf "\033[0;33m[SKIP]\033[0m  %s\n" "$1"; }
separator() { printf -- "─%.0s" {1..60}; echo; }

# Send a bridge command and wait for output.json
# Usage: send_command '{"command":"...", "args":{...}}'
send_command() {
    local json="$1"
    local timeout_secs="${2:-15}"

    # Remove stale output
    rm -f "$OUTPUT_FILE"

    # Write command
    echo "$json" > "$INPUT_FILE"

    # Wait for output.json to appear (the bridge deletes input.json and writes output.json)
    local elapsed=0
    while [[ ! -f "$OUTPUT_FILE" ]] && (( elapsed < timeout_secs )); do
        sleep 0.5
        elapsed=$((elapsed + 1))
    done

    if [[ ! -f "$OUTPUT_FILE" ]]; then
        echo '{"status":"error","command":"timeout","error":"No output.json after '"$timeout_secs"'s"}'
        return 1
    fi

    cat "$OUTPUT_FILE"
}

# Assert the output contains "status":"ok"
# Usage: assert_ok "$test_name" "$output"
assert_ok() {
    local name="$1"
    local output="$2"
    TOTAL_COUNT=$((TOTAL_COUNT + 1))

    if echo "$output" | grep -q '"status":"ok"' 2>/dev/null || echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('status')=='ok' else 1)" 2>/dev/null; then
        PASS_COUNT=$((PASS_COUNT + 1))
        log_pass "$name"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        FAILURES+=("$name")
        log_fail "$name"
        echo "  Output: $(echo "$output" | head -c 300)"
    fi
}

# Assert the output contains a specific string
assert_contains() {
    local name="$1"
    local output="$2"
    local expected="$3"
    TOTAL_COUNT=$((TOTAL_COUNT + 1))

    if echo "$output" | grep -qi "$expected" 2>/dev/null; then
        PASS_COUNT=$((PASS_COUNT + 1))
        log_pass "$name"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        FAILURES+=("$name")
        log_fail "$name — expected to contain: $expected"
        echo "  Output: $(echo "$output" | head -c 300)"
    fi
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

if [[ ! -d "$BRIDGE_DIR" ]]; then
    echo "ERROR: $BRIDGE_DIR directory not found. Is the webcure extension active?"
    echo "Make sure VS Code is running with a workspace open."
    exit 1
fi

echo
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║       WebCure Bridge Integration Test Suite                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo
log "Bridge dir: $BRIDGE_DIR"
log "Test URL:   $TEST_URL"
separator

# ---------------------------------------------------------------------------
# Test Group 1: Navigation
# ---------------------------------------------------------------------------

echo
log "=== GROUP 1: Navigation ==="

output=$(send_command '{"command":"navigate","args":{"url":"'"$TEST_URL"'"}}')
assert_ok "navigate → $TEST_URL" "$output"

sleep 1

output=$(send_command '{"command":"navigate","args":{"url":"'"$TEST_URL/login"'"}}')
assert_ok "navigate → /login" "$output"

sleep 1

output=$(send_command '{"command":"goBack","args":{}}')
assert_ok "goBack (navigateBack)" "$output"

output=$(send_command '{"command":"goForward","args":{}}')
assert_ok "goForward" "$output"

output=$(send_command '{"command":"goBack","args":{}}')
assert_ok "goBack (return to main)" "$output"

sleep 1

output=$(send_command '{"command":"refresh","args":{}}')
assert_ok "refresh" "$output"

# ---------------------------------------------------------------------------
# Test Group 2: Page Inspection
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 2: Page Inspection ==="

output=$(send_command '{"command":"getPageInfo","args":{}}')
assert_ok "getPageInfo" "$output"
assert_contains "getPageInfo has URL" "$output" "the-internet"

output=$(send_command '{"command":"getPageContent","args":{}}')
assert_ok "getPageContent" "$output"

output=$(send_command '{"command":"getPageText","args":{}}')
assert_ok "getPageText" "$output"
assert_contains "getPageText has body text" "$output" "Welcome"

output=$(send_command '{"command":"snapshot","args":{}}')
assert_ok "snapshot (accessibility)" "$output"

output=$(send_command '{"command":"extract","args":{}}')
assert_ok "extract (full page)" "$output"

output=$(send_command '{"command":"extract","args":{"selector":"h1"}}')
assert_ok "extract (h1 selector)" "$output"

output=$(send_command '{"command":"evaluate","args":{"expression":"() => document.title"}}')
assert_ok "evaluate (document.title)" "$output"

output=$(send_command '{"command":"screenshot","args":{}}')
assert_ok "screenshot (viewport)" "$output"

output=$(send_command '{"command":"screenshot","args":{"fullPage":true}}')
assert_ok "screenshot (fullPage)" "$output"

output=$(send_command '{"command":"scrapePage","args":{}}')
assert_ok "scrapePage" "$output"

output=$(send_command '{"command":"scrapeMenu","args":{}}')
assert_ok "scrapeMenu" "$output"

output=$(send_command '{"command":"getAccessibilityTree","args":{}}')
assert_ok "getAccessibilityTree" "$output"

# ---------------------------------------------------------------------------
# Test Group 3: Scrolling
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 3: Scrolling ==="

output=$(send_command '{"command":"scrollDown","args":{"pixels":300}}')
assert_ok "scrollDown 300px" "$output"
assert_contains "scrollDown result" "$output" "down"

output=$(send_command '{"command":"scrollUp","args":{"pixels":300}}')
assert_ok "scrollUp 300px" "$output"
assert_contains "scrollUp result" "$output" "up"

output=$(send_command '{"command":"scrollRight","args":{}}')
assert_ok "scrollRight (default)" "$output"

output=$(send_command '{"command":"scrollLeft","args":{}}')
assert_ok "scrollLeft (default)" "$output"

# ---------------------------------------------------------------------------
# Test Group 4: Click & Interaction
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 4: Click & Interaction ==="

output=$(send_command '{"command":"navigate","args":{"url":"'"$TEST_URL"'"}}')
assert_ok "navigate (reset to homepage)" "$output"

sleep 1

output=$(send_command '{"command":"click","args":{"target":"Form Authentication"}}')
assert_ok "click (Form Authentication link)" "$output"

sleep 1

output=$(send_command '{"command":"find","args":{"text":"Login"}}')
assert_ok "find (Login button)" "$output"

output=$(send_command '{"command":"typeText","args":{"selector":"#username","text":"tomsmith"}}')
assert_ok "typeText (#username)" "$output"

output=$(send_command '{"command":"typeText","args":{"selector":"#password","text":"SuperSecretPassword!"}}')
assert_ok "typeText (#password)" "$output"

output=$(send_command '{"command":"pressKey","args":{"key":"Enter"}}')
assert_ok "pressKey (Enter)" "$output"

sleep 1

# ---------------------------------------------------------------------------
# Test Group 5: Hover, Highlight
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 5: Hover & Highlight ==="

output=$(send_command '{"command":"navigate","args":{"url":"'"$TEST_URL/hovers"'"}}')
assert_ok "navigate → /hovers" "$output"

sleep 1

output=$(send_command '{"command":"hover","args":{"target":"img"}}')
assert_ok "hover (img element)" "$output"

output=$(send_command '{"command":"highlight","args":{"target":"h3"}}')
assert_ok "highlight (h3)" "$output"

# ---------------------------------------------------------------------------
# Test Group 6: Dropdown & Select
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 6: Dropdown & Select ==="

output=$(send_command '{"command":"navigate","args":{"url":"'"$TEST_URL/dropdown"'"}}')
assert_ok "navigate → /dropdown" "$output"

sleep 1

output=$(send_command '{"command":"selectOption","args":{"selector":"#dropdown","value":"2"}}')
assert_ok "selectOption (Option 2)" "$output"

# ---------------------------------------------------------------------------
# Test Group 7: Dialog Handling
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 7: Dialog Handling ==="

output=$(send_command '{"command":"navigate","args":{"url":"'"$TEST_URL/javascript_alerts"'"}}')
assert_ok "navigate → /javascript_alerts" "$output"

sleep 1

# Click for JS Alert (auto-handled)
output=$(send_command '{"command":"click","args":{"target":"Click for JS Alert"}}' 20)
assert_ok "click (JS Alert trigger)" "$output"

sleep 1

# Set dialog action to dismiss, then trigger confirm
output=$(send_command '{"command":"setDialogAction","args":{"accept":false}}')
assert_ok "setDialogAction (dismiss)" "$output"

output=$(send_command '{"command":"click","args":{"target":"Click for JS Confirm"}}' 20)
assert_ok "click (JS Confirm — dismiss)" "$output"

sleep 1

# Accept a confirm
output=$(send_command '{"command":"handleDialog","args":{"accept":true}}')
assert_ok "handleDialog (pre-set accept)" "$output"

output=$(send_command '{"command":"click","args":{"target":"Click for JS Confirm"}}' 20)
assert_ok "click (JS Confirm — accept)" "$output"

sleep 1

# ---------------------------------------------------------------------------
# Test Group 8: Tabs
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 8: Tab Management ==="

output=$(send_command '{"command":"listTabs","args":{}}')
assert_ok "listTabs" "$output"

output=$(send_command '{"command":"newTab","args":{}}')
assert_ok "newTab" "$output"

sleep 1

output=$(send_command '{"command":"listTabs","args":{}}')
assert_ok "listTabs (after new)" "$output"

output=$(send_command '{"command":"closeTab","args":{"index":2}}')
assert_ok "closeTab (index 2)" "$output"

# ---------------------------------------------------------------------------
# Test Group 9: Resize
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 9: Resize ==="

output=$(send_command '{"command":"resize","args":{"width":800,"height":600}}')
assert_ok "resize (800x600)" "$output"

output=$(send_command '{"command":"fullscreenBrowser","args":{}}')
assert_ok "fullscreenBrowser" "$output"

# ---------------------------------------------------------------------------
# Test Group 10: Wait
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 10: Wait ==="

output=$(send_command '{"command":"wait","args":{"ms":500}}')
assert_ok "wait (500ms)" "$output"

output=$(send_command '{"command":"navigate","args":{"url":"'"$TEST_URL/dynamic_loading/1"'"}}')
assert_ok "navigate → /dynamic_loading/1" "$output"

sleep 1

output=$(send_command '{"command":"click","args":{"target":"Start"}}' 20)
assert_ok "click (Start dynamic loading)" "$output"

output=$(send_command '{"command":"waitForText","args":{"text":"Hello World!","timeout":15000}}')
assert_ok "waitForText (Hello World!)" "$output"

# ---------------------------------------------------------------------------
# Test Group 11: Recording
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 11: Recording ==="

output=$(send_command '{"command":"startRecording","args":{}}')
assert_ok "startRecording" "$output"

# Do one action to record
output=$(send_command '{"command":"navigate","args":{"url":"'"$TEST_URL"'"}}')
assert_ok "navigate (while recording)" "$output"

sleep 1

output=$(send_command '{"command":"stopRecording","args":{}}')
assert_ok "stopRecording" "$output"

# ---------------------------------------------------------------------------
# Test Group 12: Console & Network
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 12: Console & Network ==="

output=$(send_command '{"command":"consoleMessages","args":{}}')
assert_ok "consoleMessages" "$output"

output=$(send_command '{"command":"networkRequests","args":{}}')
assert_ok "networkRequests" "$output"

# ---------------------------------------------------------------------------
# Test Group 13: Error Handling
# ---------------------------------------------------------------------------

separator
echo
log "=== GROUP 13: Error Handling ==="

output=$(send_command '{"command":"unknownCommand123","args":{}}')
TOTAL_COUNT=$((TOTAL_COUNT + 1))
if echo "$output" | grep -qi "error" 2>/dev/null; then
    PASS_COUNT=$((PASS_COUNT + 1))
    log_pass "unknown command → error response"
else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES+=("unknown command error handling")
    log_fail "unknown command error handling"
fi

# ---------------------------------------------------------------------------
# Cleanup: Close browser
# ---------------------------------------------------------------------------

separator
echo
log "=== CLEANUP ==="

output=$(send_command '{"command":"closeBrowser","args":{}}')
assert_ok "closeBrowser" "$output"

# ---------------------------------------------------------------------------
# Results Summary
# ---------------------------------------------------------------------------

echo
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    TEST RESULTS SUMMARY                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo
echo "  Total:   $TOTAL_COUNT"
echo "  Passed:  $PASS_COUNT"
echo "  Failed:  $FAIL_COUNT"
echo "  Skipped: $SKIP_COUNT"
echo

if (( FAIL_COUNT > 0 )); then
    echo "  Failed tests:"
    for f in "${FAILURES[@]}"; do
        echo "    - $f"
    done
    echo
    exit 1
else
    log_pass "All tests passed!"
    echo
    exit 0
fi
