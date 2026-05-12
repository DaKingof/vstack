# pi-flightdeck

> ⚠️ **WIP — not production ready.** APIs, settings, and UI may change without notice.

Read-only mission-control dashboard for the [`flightdeck`](../../skills/flightdeck) skill. When Pi runs as the flightdeck master agent in a tmux session, this extension surfaces the same on-disk state the daemon and master maintain — without ever mutating it.

## Highlights

- **Pause banner** — high-contrast yellow frame above the editor when flightdeck master pauses for the user. Clears automatically on resume.
- **Persistent dashboard widget** — compact tree of tracked issues with state badges, harness, model, PR number, last decision, age, and per-pane cost/turns/tokens.
- **`/flightdeck` popup** (F6) — mission-control view with six tabs: Overview, Live feed, Conversations, Conflicts & merges, Decisions, Daemon.
- Dashboard suppresses in child panes so the same state doesn't echo inside every agent.
- Optional terminal bell and auto-popup when master pauses.

## Read-only by design

The flightdeck skill owns state mutation; the daemon owns wake delivery; `pane-respond` owns sending input to inner panes. pi-flightdeck only renders what's already on disk. The skill works fine without this extension; it's purely additive UX for the Pi harness.

## Install

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
vstack add vanillagreencom/vstack --pi-extension pi-flightdeck --harness pi -y
```

Or globally:

```bash
vstack add vanillagreencom/vstack --global --pi-extension pi-flightdeck --harness pi -y
```

Restart Pi after installation.

## Commands

| Command | Action |
| --- | --- |
| `/flightdeck` | Open the mission-control popup (also F6). |
| `/flightdeck watch [args]` | Dispatch the `flightdeck watch` workflow. Used by the daemon's pi-master wake. |
| `/flightdeck:toggle` | Cycle the persistent dashboard widget (also Alt+M). |

## Settings

All settings live in the extension manager under **Flightdeck Dashboard**.

### Dashboard

| Setting | What it does |
| --- | --- |
| Show dashboard widget | Render the persistent dashboard above the editor. |
| Dashboard default state | Initial state: `hidden`, `compact`, or `expanded`. |
| Dashboard max issues | Max issue rows shown. |
| Dashboard stale-after (min) | Suppress the issue tree with a one-line hint when the daemon is dead and the last poll is older than N minutes. `0` disables. |
| Tree connector style | `unicode` or `ascii`. |

### Pause banner

| Setting | What it does |
| --- | --- |
| Show pause banner | Render the pause-for-user banner. |
| Terminal bell on pause | Ring the bell when master first pauses. |
| Auto-open popup on pause | Open the popup once when master first pauses. |

### Keyboard

| Setting | What it does |
| --- | --- |
| Popup shortcut | Default `f6`. |
| Dashboard cycle shortcut | Default `alt+m`. |

### Popup

| Setting | What it does |
| --- | --- |
| Live feed lines | Daemon log + decisions retained in Live feed. |
| Conversation excerpt chars | Max chars of last assistant text per pane. |
| Conversations turns kept | Recent assistant turns retained per pane. |

### Refresh

| Setting | What it does |
| --- | --- |
| Refresh interval | Poll rate for state files (ms). |
| Daemon state dir override | Override `FD_STATE_DIR` resolution. Leave empty for the default. |
| Master state dir (project-relative) | Directory inside the project root holding the master state file. Matches `FLIGHTDECK_STATE_DIR` (default `tmp`). |

If your project uses a non-default `FLIGHTDECK_STATE_DIR` or `FD_STATE_DIR`, set the matching extension setting so the dashboard reads the right files. Daemon tuning env vars (e.g. `FD_OC_BACKOFF_MAX_SEC`) are owned by the flightdeck skill — see its README.

## Out of scope

- No write actions. Forwarded user decisions go to master via normal Pi chat.
- No daemon control. Use `flightdeck-daemon start|stop|status|health` from the skill.
- No multi-tmux-session aggregation. Scope is the current `$TMUX` session.
