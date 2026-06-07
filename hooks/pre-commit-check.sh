#!/usr/bin/env bash
# ---
# name: pre-commit-check
# event: PreToolUse
# matcher: Bash
# description: Validate formatting and lint before git commits on source files. Supports Rust (cargo fmt + clippy) and Biome projects (JS/TS/JSON).
# safety: Prevents committing code that fails format or lint checks.
# ---

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' 2>/dev/null || true)

# Only relevant for git commit commands
if ! echo "$COMMAND" | grep -qE 'git[[:space:]]+commit'; then
  exit 0
fi

# Check staged files
STAGED=$(git diff --cached --name-only 2>/dev/null || true)
if [ -z "$STAGED" ]; then
  exit 0
fi

# Check for Rust files
if echo "$STAGED" | grep -qE '\.rs$'; then
  # Locate Cargo.toml so the hook works in repos that nest the manifest
  # (vstack's own `cli/Cargo.toml` is the canonical example) and when
  # the hook is invoked from a subdirectory. Earlier versions ran
  # `cargo fmt --check` from cwd unconditionally and misreported "could
  # not find Cargo.toml" as a fmt failure.
  MANIFEST_ARGS=()
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$REPO_ROOT" ] && [ ! -f "$REPO_ROOT/Cargo.toml" ]; then
    MANIFEST=$(echo "$STAGED" | grep -E '\.rs$' | while IFS= read -r path; do
      dir=$(dirname "$path")
      while [ -n "$dir" ] && [ "$dir" != "." ] && [ "$dir" != "/" ]; do
        if [ -f "$REPO_ROOT/$dir/Cargo.toml" ]; then
          echo "$REPO_ROOT/$dir/Cargo.toml"
          break
        fi
        dir=$(dirname "$dir")
      done
    done | head -1)
    if [ -n "$MANIFEST" ]; then
      MANIFEST_ARGS=(--manifest-path "$MANIFEST")
    fi
  fi

  # Format check
  if ! cargo fmt "${MANIFEST_ARGS[@]}" --check 2>/dev/null; then
    echo "cargo fmt --check failed. Run 'cargo fmt' first." >&2
    exit 2
  fi

  # Clippy check
  if ! cargo clippy "${MANIFEST_ARGS[@]}" --workspace --all-targets -- -D warnings 2>/dev/null; then
    echo "cargo clippy found warnings. Fix them before committing." >&2
    exit 2
  fi
fi

# Check for JS/TS/JSON files in Biome projects (no-op when the repo doesn't
# use Biome). Checks only the staged paths, so it stays fast in any repo size.
if echo "$STAGED" | grep -qE '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc)$'; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$REPO_ROOT" ] && { [ -f "$REPO_ROOT/biome.json" ] || [ -f "$REPO_ROOT/biome.jsonc" ]; }; then
    # Prefer the project-pinned binary; fall back to PATH. Never npx-install.
    BIOME=""
    if [ -x "$REPO_ROOT/node_modules/.bin/biome" ]; then
      BIOME="$REPO_ROOT/node_modules/.bin/biome"
    elif command -v biome > /dev/null 2>&1; then
      BIOME="biome"
    fi
    if [ -n "$BIOME" ]; then
      # Only staged paths that still exist (renames/deletes drop out), as
      # paths relative to the repo root since that's where biome.json lives.
      FILES=$(echo "$STAGED" | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc)$' | while IFS= read -r path; do
        [ -f "$REPO_ROOT/$path" ] && echo "$path"
      done || true)
      if [ -n "$FILES" ]; then
        # shellcheck disable=SC2086 -- intentional word splitting of file list
        if ! OUTPUT=$(cd "$REPO_ROOT" && "$BIOME" check $FILES 2>&1); then
          echo "biome check failed on staged files. Run 'biome check --write' first." >&2
          echo "$OUTPUT" | head -20 >&2
          exit 2
        fi
      fi
    fi
  fi
fi

exit 0
