# pi-task-panel

Persistent structured task panel above the Pi status line/editor.

Human-facing commands are intentionally small:

- `/tasks` or `/tasks manage` opens the interactive manager.
- `/tasks add <task>` adds one task. Use `Phase :: task` to assign a phase.
- `/tasks edit` bulk-edits tasks as plain text.
- `/tasks hide` and `/tasks show` control panel visibility.

The manager handles focused task actions: select with `↑↓`, `enter`/`s` starts, `d` marks done, `x` drops/abandons, `r` removes, `c` clears completed tasks, and `e` opens bulk edit. Compatibility slash aliases such as `start`, `done`, `drop`, `rm`, `clear-completed`, `show-all`, `compact`, `expand`, `export`, and `import` are still accepted but are not shown as the primary command surface.

`/tasks edit` uses plain text (`- task name`) with optional readable status suffixes: `(active)`, `(done)`, or `(dropped)`.

The model can update tasks with the `tasks_write` tool. Tool results render as compact inline status rows like `● Task "name" completed` by default; set `compactToolOutput=false` to use Pi's normal padded tool box. The panel keeps one active task highlighted, automatically advances to the next pending task when the active task is completed/dropped, hides when all tasks are complete, and reappears when pending work is added. Tasks can include a `phase` field; expanded mode renders phases as grouped sections.

State stores task snapshots in `tasks_write` result details, with project/session custom entries as an extra restore path. `tasks_write` runs sequentially so multiple task transitions in one assistant response cannot race. When tasks remain, `showWorkflowReminder` adds a model-facing system reminder plus hidden current task context so the agent sees the active task, remaining tasks, and explicit reconciliation rules before it answers.

Keyboard conflict: Pi uses `Ctrl+T` for thinking visibility. This package always registers the alternate shortcut from settings (`Alt+T` by default). The shortcut cycles `hidden → show 4 → show all`. It registers `Ctrl+T` only when `takeoverCtrlT` is enabled in the extension manager and Pi is reloaded.
