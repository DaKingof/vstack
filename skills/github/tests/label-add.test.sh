#!/usr/bin/env bash
# vstack#99: label-add.sh wraps `gh pr|issue edit --add-label` and emits
# pr.labeled / issue.labeled activity when running under Flightdeck.
# Standalone use outside Flightdeck remains identical to plain gh.
#
# Run:  bash skills/github/tests/label-add.test.sh
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$TEST_DIR/../scripts/commands/label-add.sh"
REPO_ROOT="$(cd "$TEST_DIR/../../.." && pwd)"
TRAMPOLINE="$REPO_ROOT/skills/flightdeck/scripts/flightdeck-state"

SANDBOX="$(mktemp -d -t fd-label-add-XXXXXX)"
export ACTIVITY_FILE="$SANDBOX/activity.jsonl"
export GH_LOG="$SANDBOX/gh-calls.log"
STUB_DIR="$SANDBOX/stub"
mkdir -p "$STUB_DIR"

PASS=0
FAIL=0

cleanup() { rm -rf "$SANDBOX" 2>/dev/null || true; }
trap cleanup EXIT

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf '  PASS: %s\n' "$label"
        PASS=$((PASS + 1))
    else
        printf '  FAIL: %s\n    expected: %s\n    actual:   %s\n' "$label" "$expected" "$actual" >&2
        FAIL=$((FAIL + 1))
    fi
}

assert_contains() {
    local label="$1" needle="$2" haystack="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        printf '  PASS: %s\n' "$label"
        PASS=$((PASS + 1))
    else
        printf '  FAIL: %s\n    expected to contain: %s\n    actual: %s\n' "$label" "$needle" "$haystack" >&2
        FAIL=$((FAIL + 1))
    fi
}

# Stub gh: record the call args and exit 0.
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >> "$GH_LOG"
exit 0
STUB
chmod +x "$STUB_DIR/gh"
export PATH="$STUB_DIR:$PATH"
export FLIGHTDECK_STATE_BIN="$TRAMPOLINE"

# Round 1: unmanaged invocation — no activity should be emitted.
: > "$GH_LOG"
rm -f "$ACTIVITY_FILE"
unset FLIGHTDECK_MANAGED FLIGHTDECK_ACTIVITY_FILE FLIGHTDECK_ENTRY_ID
"$SCRIPT" 44 defer-ci >/dev/null
assert_contains "unmanaged: gh pr edit invoked" "gh pr edit 44 --add-label defer-ci" "$(cat "$GH_LOG")"
if [ -e "$ACTIVITY_FILE" ]; then
    FAIL=$((FAIL + 1))
    printf '  FAIL: unmanaged should not emit activity (file exists)\n' >&2
else
    PASS=$((PASS + 1))
    printf '  PASS: unmanaged emits no activity row\n'
fi

# Round 2: managed invocation with FLIGHTDECK_ACTIVITY_FILE — activity row written.
: > "$GH_LOG"
rm -f "$ACTIVITY_FILE"
export FLIGHTDECK_MANAGED=1
export FLIGHTDECK_ACTIVITY_FILE="$ACTIVITY_FILE"
export FLIGHTDECK_SESSION=label-add-test
"$SCRIPT" 44 defer-ci --reason "skip heavy CI" >/dev/null
assert_contains "managed pr: gh pr edit invoked" "gh pr edit 44 --add-label defer-ci" "$(cat "$GH_LOG")"
if [ ! -s "$ACTIVITY_FILE" ]; then
    FAIL=$((FAIL + 1))
    printf '  FAIL: managed should emit an activity row but file is empty/missing\n' >&2
else
    PASS=$((PASS + 1))
    printf '  PASS: managed pr emits a row\n'
    line="$(tail -n 1 "$ACTIVITY_FILE")"
    assert_eq "managed pr type" "pr.labeled" "$(jq -r '.type' <<<"$line")"
    assert_eq "managed pr summary" "Added defer-ci to PR #44: skip heavy CI" "$(jq -r '.summary' <<<"$line")"
    assert_eq "managed pr refs.pr_number" "44" "$(jq -r '.refs.pr_number' <<<"$line")"
    assert_eq "managed pr details.label" "defer-ci" "$(jq -r '.details.label' <<<"$line")"
    assert_eq "managed pr details.reason" "skip heavy CI" "$(jq -r '.details.reason' <<<"$line")"
    assert_eq "managed pr severity" "info" "$(jq -r '.severity' <<<"$line")"
    assert_eq "managed pr importance" "normal" "$(jq -r '.importance' <<<"$line")"
fi

# Round 3: managed issue invocation — emits issue.labeled.
: > "$GH_LOG"
rm -f "$ACTIVITY_FILE"
export FLIGHTDECK_ENTRY_ID=VST-123
"$SCRIPT" 88 needs-triage --issue >/dev/null
assert_contains "managed issue: gh issue edit invoked" "gh issue edit 88 --add-label needs-triage" "$(cat "$GH_LOG")"
if [ ! -s "$ACTIVITY_FILE" ]; then
    FAIL=$((FAIL + 1))
    printf '  FAIL: managed issue should emit an activity row\n' >&2
else
    PASS=$((PASS + 1))
    printf '  PASS: managed issue emits a row\n'
    line="$(tail -n 1 "$ACTIVITY_FILE")"
    assert_eq "managed issue type" "issue.labeled" "$(jq -r '.type' <<<"$line")"
    assert_eq "managed issue summary" "Added needs-triage to issue 88" "$(jq -r '.summary' <<<"$line")"
    assert_eq "managed issue refs.issue_id" "88" "$(jq -r '.refs.issue_id' <<<"$line")"
    assert_eq "managed issue entry_id" "VST-123" "$(jq -r '.entry_id' <<<"$line")"
fi

# Round 4: gh failure propagates non-zero exit and skips emission.
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >> "$GH_LOG"
exit 4
STUB
chmod +x "$STUB_DIR/gh"
rm -f "$ACTIVITY_FILE"
set +e
"$SCRIPT" 44 defer-ci --reason failure-path >/dev/null
rc=$?
set -e
assert_eq "gh failure rc propagates" "4" "$rc"
if [ -e "$ACTIVITY_FILE" ]; then
    FAIL=$((FAIL + 1))
    printf '  FAIL: gh failure should skip emission, file unexpectedly exists\n' >&2
else
    PASS=$((PASS + 1))
    printf '  PASS: gh failure skips emission\n'
fi

printf '\nPASS=%d FAIL=%d\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then exit 1; fi
