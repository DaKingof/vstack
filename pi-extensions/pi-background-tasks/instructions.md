## pi-background-tasks — using `bg_task` and `bg_status`

`bg_task` runs shell commands without blocking the conversation; `bg_status` inspects/stops them. Use these instead of `nohup`, `&`, `disown`, or foreground polling loops.

When to use `bg_task action: "spawn"`:
- Long-running processes the user wants to keep alive across turns: dev servers, watchers, log tails, `pi-bridge`/session monitors, agent panes, build daemons.
- Anything you would otherwise background with `&` or wrap in `nohup`.
- Foreground bash monitor loops (`while true; do …; sleep N; done`) are auto-diverted into a background task — when that happens, continue the turn and inspect the task later, do not wait on the foreground bash.

When to use `bg_status` (or `bg_task` with the same actions):
- `action: "list"` — see what is currently running.
- `action: "log"` (with `pid` or `id`) — read accumulated output.
- `action: "stop"` — terminate by pid or id (sends SIGTERM to the process group on Unix).
- `action: "clear"` (bg_task only) — drop finished entries from the list.

Spawn parameters worth knowing:
- `notifyOnExit` (default true) — wakes the agent when the task exits.
- `notifyOnOutput` (default false) + `notifyPattern` — wake on substring or `/regex/flags` matches in new output.
- `timeoutSeconds` defaults to 0 (disabled). Set when you actually want a timeout.
- `title` is the user-facing label.
- `cwd` defaults to the current working directory; set explicitly when the task should run elsewhere.

Rules:
- Do not spawn a task and then wait on its output in foreground — that defeats the point. Spawn, continue, inspect later.
- Always `stop` tasks you started for a turn-scoped purpose before finishing the turn.
- Save the returned task id/pid; you will need it for `log`/`stop`.
