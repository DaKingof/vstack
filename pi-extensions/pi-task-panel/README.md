# pi-task-panel

Persistent structured task panel above the Pi status line/editor.

Commands include `/todo add`, `/todo start`, `/todo done`, `/todo drop`, `/todo rm`, `/todo clear-completed`, `/todo hide`, `/todo show`, `/todo show-all`, `/todo compact`, `/todo expand`, `/todo edit`, `/todo export`, `/todo import`, and `/todo manage`.

The model can update tasks with the `todo_write` tool. The panel keeps one active task highlighted, automatically advances to the next pending task when the active task is completed/dropped, hides when all tasks are complete, and reappears when pending work is added.

Keyboard conflict: Pi uses `Ctrl+T` for thinking visibility. This package always registers the alternate shortcut from settings (`Alt+T` by default). The shortcut cycles `hidden → show 4 → show all`. It registers `Ctrl+T` only when `takeoverCtrlT` is enabled in the extension manager and Pi is reloaded.
