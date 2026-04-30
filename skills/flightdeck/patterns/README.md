# Flightdeck patterns — index

Behaviors the master agent must encode when responding to spawned panes, grouped by domain. Workflows in `../workflows/` reference these patterns; scripts in `../scripts/` enforce some of them in code.

| Pattern doc | Covers |
|-------------|--------|
| [`tmux-monitoring.md`](tmux-monitoring.md) | Pane targeting, bell handling, capture-pane idioms, per-harness send/read adapter contracts |
| [`prompt-handlers.md`](prompt-handlers.md) | Classification tags + per-tag handler logic — cleanup scope, combine-guidance, bot-review skip, rebase template, parent-vs-related, verify-don't-trust |
| [`conflict-detection.md`](conflict-detection.md) | File-level conflict graph, defer-ci semantics, force-merge predicate |
| [`decision-biases.md`](decision-biases.md) | Scope-creep detector, smaller-PR-first, rule-of-three, expansion bias, merge-order tiebreakers |
| [`claude-channels.md`](claude-channels.md) | Opt-in claude code Channels MCP webhook + JSONL adapter; known orchestration-trust limitation |
| [`opencode-questions.md`](opencode-questions.md) | Opencode question-tool routing via HTTP API; off-list-label policy |
