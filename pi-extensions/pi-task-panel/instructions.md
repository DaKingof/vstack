## pi-task-panel — using `tasks_write`

The Pi `tasks_write` tool is the only way the user sees what you are working on. Writing tasks once and ignoring them after is the most common failure mode — the panel must stay current throughout the turn, not only at the end.

When to use:
- Before any non-trivial multi-step work, call `tasks_write` with `action: "replace"` and a full `tasks: [...]` list.
- The moment you start an item, call `action: "start_task"` with that task's id or content.
- The moment you finish one, call `action: "mark_done"` (auto-advances to the next pending task).
- When scope changes mid-turn, call `action: "add_task"` for new follow-ups and `action: "drop_task"` for items that no longer apply.

Hard rules:
- Never end a turn with a stale `in_progress` task. If the work has moved on, `start_task` the right one or `drop_task` it before replying.
- Do not narrate task transitions in prose ("now I'll start X") — just call the tool.
- Use `mark_done` for completed work; use `drop_task` only for obsolete/out-of-scope items.
- For one-shot trivial requests, do not create a task panel at all.

Slash commands the user has: `/tasks`, `/tasks compact`, `/tasks expanded`, `/tasks hide`. You do not invoke these — they are user-facing.