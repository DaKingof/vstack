#!/usr/bin/env bash
# Regression tests for worktree remove diagnostics and branch cleanup.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_SCRIPT="$(cd "$TEST_DIR/.." && pwd)/scripts/worktree"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0

assert_eq() {
  local got="$1" want="$2" name="$3"
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        expected: %s\n        got:      %s\n' "$name" "$want" "$got"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        wanted substring: %s\n        in: %s\n' "$name" "$needle" "$haystack"
  fi
}

assert_path_absent() {
  local path="$1" name="$2"
  if [[ ! -e "$path" ]]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        still exists: %s\n' "$name" "$path"
  fi
}

assert_branch_exists() {
  local repo="$1" branch="$2" name="$3"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        missing branch: %s\n' "$name" "$branch"
  fi
}

assert_branch_absent() {
  local repo="$1" branch="$2" name="$3"
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s\n        branch still exists: %s\n' "$name" "$branch"
  else
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$name"
  fi
}

make_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name Test
  printf 'base\n' > "$repo/file.txt"
  git -C "$repo" add file.txt
  git -C "$repo" commit -q -m base
}

echo "=== worktree remove ==="

# Merged/no-extra-commit branch: worktree and branch both disappear, exit 0.
MERGED_ROOT="$TMP_ROOT/merged"
make_repo "$MERGED_ROOT/main"
git -C "$MERGED_ROOT/main" worktree add -q -b issue-merged "$MERGED_ROOT/trees/issue-merged" main
merged_out=$(cd "$MERGED_ROOT/main" && "$WORKTREE_SCRIPT" remove ISSUE-MERGED 2>"$MERGED_ROOT/merged.err")
assert_eq "$merged_out" "Removed: $MERGED_ROOT/trees/issue-merged" "merged branch removal exits cleanly"
assert_path_absent "$MERGED_ROOT/trees/issue-merged" "merged branch worktree removed"
assert_branch_absent "$MERGED_ROOT/main" "issue-merged" "merged branch deleted"

# Unmerged branch: worktree is removed, branch remains, exit 1 includes diagnostic.
UNMERGED_ROOT="$TMP_ROOT/unmerged"
make_repo "$UNMERGED_ROOT/main"
git -C "$UNMERGED_ROOT/main" worktree add -q -b issue-unmerged "$UNMERGED_ROOT/trees/issue-unmerged" main
printf 'branch-only\n' >> "$UNMERGED_ROOT/trees/issue-unmerged/file.txt"
git -C "$UNMERGED_ROOT/trees/issue-unmerged" add file.txt
git -C "$UNMERGED_ROOT/trees/issue-unmerged" commit -q -m 'branch only'
set +e
unmerged_out=$(cd "$UNMERGED_ROOT/main" && "$WORKTREE_SCRIPT" remove ISSUE-UNMERGED 2>"$UNMERGED_ROOT/unmerged.err")
unmerged_code=$?
set -e
assert_eq "$unmerged_code" "1" "unmerged branch removal exits nonzero"
assert_eq "$unmerged_out" "Removed: $UNMERGED_ROOT/trees/issue-unmerged" "unmerged branch still reports removed worktree"
assert_path_absent "$UNMERGED_ROOT/trees/issue-unmerged" "unmerged branch worktree removed"
assert_branch_exists "$UNMERGED_ROOT/main" "issue-unmerged" "unmerged branch retained"
assert_contains "$(cat "$UNMERGED_ROOT/unmerged.err")" "could not delete local branch 'issue-unmerged'" "unmerged branch diagnostic names failed cleanup step"
assert_contains "$(cat "$UNMERGED_ROOT/unmerged.err")" "branch -D \"issue-unmerged\"" "unmerged branch diagnostic gives manual recovery command"

echo
printf 'pass: %d   fail: %d\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
