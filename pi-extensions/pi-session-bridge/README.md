# pi-session-bridge

![Session bridge CLI flow](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-session-bridge/assets/session-bridge-cli.png)

Control a running Pi session from outside the TUI. The interactive Pi terminal stays visible; a Unix-domain socket exposes a structured JSONL side channel for external clients.

## Highlights

- External clients send prompts, steering, follow-ups, and aborts without tmux key injection.
- Subscribe to live Pi events (messages, tool calls, agent end) without scraping panes.
- Discover active Pi sessions through registry files; target by pid, cwd, session, or name.
- `pi-bridge` CLI handles common operations; raw JSONL protocol is documented for any language.
- When `pi-questions` is loaded, external clients can list, answer, and reject pending questions.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-session-bridge):

```bash
pi install npm:@vanillagreen/pi-session-bridge
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-session-bridge --harness pi -y
```

Restart Pi after installation.

`pi-bridge` is symlinked into the install scope's `bin/` (`.pi/bin/pi-bridge` project, `~/.pi/agent/bin/pi-bridge` global). Add the directory to `PATH` or run by path.

## Commands

| Command | Action |
| --- | --- |
| `/bridge:status` | Show socket and registry paths. |
| `/bridge:ping [text]` | Emit a `bridge_pong` event without calling a model. |

## `pi-bridge` CLI

```bash
pi-bridge list
pi-bridge state --pid <pid>
pi-bridge commands --pid <pid>
pi-bridge stream --pid <pid>
pi-bridge history --pid <pid> 20
pi-bridge send --pid <pid> "message for the agent"
pi-bridge steer --pid <pid> "steer current work"
pi-bridge follow-up --pid <pid> "after you finish, do this"
pi-bridge questions --pid <pid>
pi-bridge answer --pid <pid> --request-id que_... --answers '[["Stop here"]]'
pi-bridge reject --pid <pid> --request-id que_...
pi-bridge emit --pid <pid> "hello"
```

If exactly one active bridge exists, target flags are optional. Filters: `--pid`, `--socket`, `--session`, `--name`, `--cwd`.

## Raw protocol

Connect to the advertised Unix socket and exchange one JSON object per LF-delimited record. Requests may include `id`; responses use `type:"response"` with the same `id`.

Example requests:

```json
{"id":"1","type":"get_state"}
{"id":"2","type":"prompt","message":"Run tests","deliverAs":"auto"}
{"id":"3","type":"steer","message":"Focus on errors"}
{"id":"4","type":"follow_up","message":"Summarize when done"}
{"id":"5","type":"abort"}
```

Example response and event:

```json
{"type":"response","id":"1","command":"get_state","success":true,"data":{}}
{"type":"event","event":"message_update","timestamp":"...","data":{}}
```

Clients receive events by default. Send `{"type":"subscribe","enabled":false}` to mute them.

## Slash command notes

`pi-bridge send` does **not** expand slash commands the way Pi's editor does. Effects:

- Bare extension commands (e.g. `/flightdeck`, `/bridge:ping`) work.
- Skill commands (`/skill:foo`) arrive as raw text to the LLM — the skill body isn't auto-loaded.
- Prompt templates (`/<name>` from `.pi/prompts/*`) arrive as raw text.

Workaround: send the bare extension command form, or have the extension re-dispatch via `ctx.ui.pasteToEditor("/skill:foo\n")`.

## Settings

All settings live in the extension manager under **Session Bridge**.

| Setting | What it does |
| --- | --- |
| Bridge directory | Override the sockets/registry directory. `PI_BRIDGE_DIR` env var still wins. |
| Event history limit | Events retained for history clients. |
| Max request line bytes | Maximum JSONL request size accepted. |
| Registry heartbeat | Ms between registry file updates. |
| Notify on start | In-TUI notification when the bridge starts. |
| Show status badge | Show `bridge:<pid>` in the Pi footer. |

## Security

The socket can trigger real agent work in the owning Pi process. Keep `PI_BRIDGE_DIR` private. Don't expose the socket to other users or untrusted containers.
