# Decider

Architectural decision document management — templates, creation workflows, search CLI, and supersession tracking.

## Structure

```
skills/decider/
├── SKILL.md                  # Agent-facing skill definition
├── templates/
│   ├── decision-entry.md     # Decision file templates (minimal, standard, comprehensive)
│   └── index-row.md          # INDEX.md table row template
├── workflows/
│   ├── create-decision.md    # Create: assign ID, write file, add INDEX row
│   ├── update-decision.md    # Supersede, partial supersede, or revisit
│   └── search-decisions.md   # Search by issue, keywords, or ID
├── schemas/
│   └── decision-format.md    # Format constraints for decision documents
└── scripts/
    └── decisions             # CLI entry point
```

## Setup

1. Create a decisions directory with an `INDEX.md`:

```bash
mkdir -p docs/decisions
cat > docs/decisions/INDEX.md <<'EOF'
# Architectural Decision Log

| Date | ID | Research | Decision | Rationale | Revisit When | Status | Link |
|------|----|----------|----------|-----------|--------------|--------|------|
EOF
```

2. Verify: `decisions list && decisions next-id`

Optionally set `DECISIONS_DIR` in `.env.local` to override auto-discovery (searches `docs/decisions/`, `decisions/`, `doc/decisions/`, `adr/`).

## Decision Templates

| Template | Lines | When to Use |
|----------|-------|-------------|
| Minimal | 15-30 | Single choice, clear winner |
| Standard | 80-200 | Multiple alternatives, comparison tables |
| Comprehensive | 200-600 | Architecture-level, multi-concern |

## Dependencies

- `bash` 4+
- `jq`
- GNU `grep` with `-P` (PCRE): available as `grep`, `ggrep`, or Homebrew `gnubin/grep`
