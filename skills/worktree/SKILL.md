---
name: worktree
description: "Git worktree management: create, list, remove isolated working copies with env/config symlinks."
license: MIT
user-invocable: true
argument-hint: "create <ID> [--base <branch>] [--from <ref>] [--pr <N>] | list | remove <ID|path>"
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# Worktree Management

Portable git worktree manager. Layout: `project/main` (repo) + `project/trees/{id}` (worktrees).

Resolves project root via `git rev-parse`, detects default branch automatically, and reads all project-specific config from `.env.local`.

```bash
.agents/skills/worktree/scripts/worktree <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `create` | Create worktree for issue. Reuses existing (with rebase). Auto-detects PR branches via `gh`. |
| `list` | List all worktrees |
| `remove` | Remove worktree, clean symlinks, prune branches |
| `cleanup` | Remove worktrees whose branches are merged |
| `path` | Print worktree path for issue ID |
| `exists` | Check if worktree exists for issue ID |
| `check` | Pre-create git state check (JSON: uncommitted, unpushed) |
| `push` | Push worktree branch with auto-rebase |

`remove` deletes the worktree before deleting the local branch. Branch deletion uses safe `git branch -d`; if that fails after worktree removal, the script exits non-zero with a diagnostic naming the remaining branch and manual `git branch -D` recovery command.

### `create` flags

| Flag | Effect |
|------|--------|
| `--base BRANCH` | Checkout an existing remote branch into the worktree |
| `--from REF` | Create a new branch (named after ID) starting from REF (branch, tag, or commit) |
| `--pr NUMBER` | Look up the branch from a GitHub PR number (implies `--base`) |

## Configuration

Set in `.env.local`:

| Variable | Effect |
|----------|--------|
| `WORKTREE_SYMLINKS` | Space-separated paths symlinked from main checkout into each worktree; include `.env.local` if worktrees should share local env/config |
| `WORKTREE_RELATIVE_SYMLINKS` | Space-separated `path=target` symlinks created inside each worktree, with relative targets resolving from the link location |
| `WORKTREE_COPIES` | Space-separated files copied from main checkout into each worktree |
| `WORKTREE_MKDIRS` | Space-separated directories created inside each worktree with `mkdir -p`; use for gitignored scratch dirs such as `tmp` |

Example: share local env plus generated Claude assets, but keep `.claude/CLAUDE.md` pointed at each worktree's own `AGENTS.md`:

```bash
WORKTREE_SYMLINKS=".env.local .claude/agents .claude/hooks .claude/skills"
WORKTREE_RELATIVE_SYMLINKS=".claude/CLAUDE.md=../AGENTS.md"
WORKTREE_MKDIRS="tmp"
```
