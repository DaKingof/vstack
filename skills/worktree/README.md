# Git Worktree Management

Git worktree lifecycle management with env/config symlinks.

## Structure

```
skills/worktree/
├── SKILL.md          # Agent-facing skill definition
└── scripts/
    └── worktree      # Entry point
```

## Setup

Run from the main checkout of a git repo with an `origin` remote. Optionally add `.env.local` settings.

```bash
./scripts/worktree create PROJ-123
./scripts/worktree list
./scripts/worktree remove PROJ-123
```

Defaults: detects branch from `origin/HEAD` (fallback: `main`), creates worktrees under sibling `trees/`, symlinks `.env.local` automatically.

`remove` deletes the worktree first, then tries `git branch -d` for the associated local branch. If Git refuses the safe branch delete (for example, the branch is not merged into the current main checkout), the command exits non-zero and prints a diagnostic naming the remaining branch plus the manual `git branch -D` recovery command.

## Configuration

Set in `.env.local` — all optional:

| Variable | Purpose |
|----------|---------|
| `WORKTREE_DEFAULT_BRANCH` | Override default branch detection |
| `WORKTREE_SYMLINKS` | Space-separated paths to symlink into worktrees |
| `WORKTREE_COPIES` | Space-separated files to copy into worktrees |
| `BOT_NAME` / `BOT_EMAIL` | Git identity for worktree commits |
| `BOT_SIGNING_KEY` | SSH signing key for commits |
| `BOT_REMOTE_NAME` / `BOT_REMOTE_URL` | Remote for bot pushes |
