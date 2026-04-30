# Tmux monitoring patterns

Pane targeting, bell handling, and capture-pane idioms for safely observing the per-issue panes spawned by orchestration.

> **Fallback path notice:** all four supported harnesses (opencode, claude code, pi, codex) have a wired adapter — `pane-poll` and `pane-respond` route data through HTTP / Unix-socket / WS rather than tmux capture-pane / send-keys. The tmux primitives below remain the **fallback path** for panes whose bridge metadata is absent (legacy session, port exhausted, missing dependency). Daemon and scripts log `<adapter>-unavailable: <reason>` before falling through, never silent.

## Pane-0 rule

**Always target the explicit pane index `<session>:<window>.0` for orchestrator-pane reads.**

`tmux capture-pane -t <session>:<window>` (no `.<pane>` suffix) defaults to the **currently active pane** of that window. When the per-issue agent inside a spawned window has itself spawned sub-agent panes (e.g., opencode's `Iced Task` sub-agent, claude code's parallel sub-agent panes, codex worker panes), the active pane is often one of those sub-agent panes — NOT the per-issue orchestrator's main TUI.

Capturing the wrong pane misses the per-issue orchestrator's prompt. Symptom: flightdeck thinks the issue is idle when it's actually waiting for a response.

### The rule

```bash
# WRONG — captures whatever pane happens to be active
tmux capture-pane -t HT:cc-463 -p

# RIGHT — captures the orchestrator pane explicitly
tmux capture-pane -t HT:cc-463.0 -p -S -200
```

### When pane 0 isn't the orchestrator

Pane indices follow tmux's `pane-base-index` option — commonly `0`, but some configs use `1`. `pane-registry init` queries the option and uses it as the default index, so the registry entry is correct on first try when the orchestrator is in the default position.

Some TUIs lay out their main UI on a non-default pane regardless. At registry init, fingerprint each window's panes:

```bash
for pane_idx in $(tmux list-panes -t <session>:<window> -F '#{pane_index}'); do
  buf=$(tmux capture-pane -t <session>:<window>.$pane_idx -p -S -50)
  if echo "$buf" | grep -qE '(❯ |claude code|opencode|codex>|■■■)' ; then
    orchestrator_pane=$pane_idx
    break
  fi
done
```

Persist the resolved index per issue as `pane_target` in master state (e.g., `"pane_target": "HT:cc-463.0"`). Use it for every subsequent capture-pane and send-keys call on that issue.

If fingerprinting fails (no sentinel matches on any pane), default to pane 0 and log a warning. Pane 0 is right for opencode and claude code in standard layouts.

### Capture-pane scrollback depth

Use `-S -200` for prompt classification. This captures the last 200 lines, enough to see the full prompt (most TUI prompts are <30 lines) plus surrounding context. Going deeper is wasteful; going shallower can miss multi-screen prompts (e.g., multi-issue audit prompts).

```bash
tmux capture-pane -t <session>:<window>.0 -p -S -200
```

## Atomic bell clearing

After every response sent to a pane, clear the window's bell flag. Otherwise the user's tmux status bar continues to show "needs attention" for a prompt the master already handled.

### The chained-command idiom

```bash
ORIG=$(tmux display-message -p '#{window_id}')
tmux select-window -t <session>:<window> \; select-window -t $ORIG
```

The `\;` chains both `select-window` calls in a single tmux command. The client coalesces them; the intermediate state is never rendered. Result: the bell flag clears (because tmux clears flags on window-view) but the user sees no flicker, even if attached.

### Standard pattern after every response

```bash
# 1. Send the response
tmux send-keys -t <session>:<window>.0 "<RESPONSE>" Enter

# 2. Clear the bell atomically
ORIG=$(tmux display-message -p '#{window_id}')
tmux select-window -t <session>:<window> \; select-window -t $ORIG
```

Encoded in `scripts/pane-clear-bell` and called automatically by `scripts/pane-respond` after every send-keys.

## Window state flags reference

Built-in flags from `tmux list-windows`:

| Flag | Per-window field | Meaning |
|------|------------------|---------|
| `*` | `window_active` | Currently focused (only useful for "which is the user looking at") |
| `-` | `window_last_flag` | Last-focused (previous nav) |
| `#` | `window_bell_flag` | Bell character received → likely needs attention |
| `!` | `window_activity_flag` | Output activity since last view (requires `monitor-activity on`) |
| `~` | `window_silence_flag` | No output for N seconds (requires `monitor-silence N`) |

Flightdeck's primary signal is `window_bell_flag`. If a project has `monitor-silence` enabled, `window_silence_flag` is a useful secondary signal for detecting stuck panes.

Quick scan command:

```bash
tmux list-windows -t <session> -F '#{window_index}:#{window_name} bell=#{window_bell_flag} activity=#{window_activity_flag} silence=#{window_silence_flag}'
```

## Send-keys quirks to be aware of

- **Bracketed paste vs typing**: long inputs (rebase guidance payloads) should use `tmux load-buffer + paste-buffer` or `send-keys -l` to avoid keybinding interpretation in the receiving TUI.
- **Enter key**: `tmux send-keys ... Enter` is portable. `\n` in the payload string does NOT submit; the literal `Enter` token does.
- **Multi-line payloads**: prefer `load-buffer` + `paste-buffer` for anything over ~200 chars; long send-keys can be misinterpreted by some TUIs as paste-bracketed input.

## Per-harness signals

Per-harness adapters live in `pane-respond` (sending), `pane-poll` (reading), and the daemon's per-pane subscribers. With an adapter wired, structured input/output replaces tmux capture-pane / send-keys for that pane; tmux remains the documented fallback.

### Send path (script: `pane-respond`)

| Harness | Adapter | Tmux fallback |
|---------|---------|---------------|
| Claude Code | Channels MCP webhook POST (opt-in via `--use-channels` / `FLIGHTDECK_CLAUDE_CHANNELS=1`) | `tmux load-buffer + paste-buffer + Enter`, plus arrow-nav for `--option N` (Numbers are NOT shortcuts; they're buffered as text). |
| opencode | `opencode run --attach --format json` to the per-pane HTTP server. `--option N` sends bare digit as message text; `--question` posts to `POST /question/<id>/{reply,reject}`. | Tmux paste-buffer for free text. `--option` not supported (no digit-key tmux mechanic for opencode). |
| pi | `pi-bridge send --pid <PID> --auto <msg>` via the Unix-socket session bridge | Tmux paste-buffer fallback |
| codex | `codex-bridge send --url <ws> --thread <TID>` via the JSON-RPC client to `codex app-server` | Tmux paste-buffer fallback |

### Read path (script: `pane-poll` + daemon subscribers)

| Harness | Adapter | Tmux fallback |
|---------|---------|---------------|
| Claude Code | Tail `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` for assistant `stop_reason` events | `tmux capture-pane -p -S -200` |
| opencode | `GET /session/<id>/message` → last assistant text. Daemon also polls `GET /question` for the question tool. | `tmux capture-pane -p -S -200` |
| pi | `pi-bridge history` / `pi-bridge stream` filtered for assistant `turn_end` | `tmux capture-pane -p -S -200` |
| codex | `codex-bridge turns` / stream filtered for `thread/status/changed → idle` | `tmux capture-pane -p -S -200` |

### Idle / quiescent indicator (handler: `close-issue.md` § 1)

When an adapter is active, "idle" is observed structurally (turn-end event with no follow-up tool calls within debounce). For tmux fallback only:

| Harness | Tmux-fallback signal |
|---------|----------------------|
| Claude Code | `* Idle` line near buffer end, no input cursor waiting |
| opencode / pi / codex | Adapter-driven; tmux fallback uses bell-cleared + hash-stable buffer for two consecutive polls |

### Destroyed-CWD failure pattern (handler: `close-issue.md` § 1)

Inner pane's shell is dead because the worktree was removed mid-session. Subsequent tool calls fail to set cwd.

| Harness | Signal |
|---------|--------|
| Claude Code | `Path does not exist` in tool error including a worktree path; OR explicit `SESSION CWD DESTROYED` message |
| opencode / pi / codex | Adapter HTTP/socket call returns connection error (server up but session dead) — caller logs `<adapter>-unavailable: cwd-destroyed` and treats the issue as `dead` |

To add an adapter for a new harness:
1. Verify the actual contract by inspecting the harness in interactive use (server endpoints, socket protocol, or keystroke mechanic).
2. Add a `<harness>_*_*` function in the relevant script (`pane-respond`, `pane-poll`, `flightdeck-daemon`).
3. Register it in the dispatch case.
4. Update both tables above with the mechanic.
5. Add a smoke test under `skills/flightdeck/tests/<harness>-smoke`.
