# pi-bridge slash dispatch research

## Verdict table

| Approach | Verdict | Evidence |
| --- | --- | --- |
| A. `ctx.ui.pasteToEditor` from bridge handler | Partial, not sufficient | `currentCtx` is populated from extension event/command contexts in `session-bridge.ts` before `sendPrompt` runs, and `ExtensionUIContext` exposes `pasteToEditor` (`types.ts:205-206`). Interactive Pi implements it as `this.editor.handleInput("\x1b[200~...\x1b[201~")` (`interactive-mode.ts:1958-1960`). Live patch confirmed bridge handler can call it, but trailing `\n` is bracketed-paste content, not submit: after `pi-bridge send "/probe:cmd paste-A1"`, history still showed only `bridge_start`; no `input` or command event until an external Enter was pressed. Then probe log showed `{"event":"command","args":"paste-A1"}`. So it can paste editor text but cannot submit by itself. Non-interactive/RPC/no-UI contexts degrade/no-op (`runner.ts:200-209`, RPC docs say `pasteToEditor` only delegates to editor text). |
| B. `pi.exec("tmux", ...)` to drive own pane | Works in principle, high-risk; use only with strict own-pane resolution | Manual tmux key injection is known to enter the full editor pipeline. Live research found the dangerous part: `tmux display-message -p '#{pane_id}'` inside an extension resolved the active tmux client pane, not the Pi process pane, and misrouted `/probe:cmd ...` into the parent tab. Safe resolution must not use current-client state. A follow-up no-key-injection probe verified parent-chain resolution works: `processPid=4169076`, chain `4169076 -> 4169020 -> ...`, and `tmux list-panes -a -F '#{pane_pid} #{pane_id} #{window_name}'` matched `4169020 %972 pi-br-pane`. Dispatch via send-keys was not re-tested after the misroute; implementation should be guarded and isolated-tested before release. |
| C. Client-side expansion before `sendUserMessage` | Works for skills and prompt templates; cannot dispatch extension/TUI commands | Upstream skill expansion reads loaded skill metadata from `resourceLoader.getSkills()`, strips frontmatter, and wraps body as `<skill ...>` (`agent-session.ts:1147-1161`). Prompt templates parse args and substitute `$1`, `$@`, `$ARGUMENTS`, `${@:N}` (`prompt-templates.ts:24-92`, `282-295`). `pi.getCommands()` exposes loaded command metadata, including `source`, `name`, and `sourceInfo.path` for prompt/skill resources (`agent-session.ts:2131-2154`, `types.ts:1220-1221`). Live patched bridge expanded `/skill:probe-skill skillArg`; probe saw `PROBE_SKILL_BODY_UNIQUE` in the `input` and `before_agent_start` prompt. Live patched bridge expanded `/probe-template promptArg two`; probe saw `PROBE_TEMPLATE_BODY_UNIQUE promptArg two`. Live `/probe:cmd extArg` remained raw user prompt and did not call command handler, proving C cannot handle extension commands. |
| D. Monkey-patch `pi.sendUserMessage` / hidden `prompt()` | Does not work for this goal | The extension API object is mutable (`Object.isFrozen(pi) === false`, descriptor for `sendUserMessage` is writable/configurable), but `pi.sendUserMessage` is only a wrapper delegating to runtime (`loader.ts:269-278`), and runtime calls `AgentSession.sendUserMessage` (`agent-session.ts:2168-2174`). That method always calls `this.prompt(..., { expandPromptTemplates: false, ... })` and does not read unknown options (`agent-session.ts:1317-1347`). Live probe found exposed keys only: `on`, `registerTool`, `registerCommand`, `sendMessage`, `sendUserMessage`, `exec`, `getCommands`, etc.; no `prompt`, `session`, `_session`, or `unsafe` chain. |
| E. Side-channel helper process | Possible, but overkill | Helper could own tmux injection and use the same parent-chain pane resolver. It adds lifecycle/socket complexity but no new capability beyond B. Keep only as fallback if in-process `pi.exec("tmux", ...)` proves unreliable. |
| F. Web/upstream research | No available upstream fix in pinned API | Current package is `@earendil-works/pi-coding-agent` `0.74.0` in local Bun cache. `sendUserMessage` type still only accepts `{ deliverAs?: "steer" | "followUp" }` (`types.ts:1187-1190`). Upstream issue [badlogic/pi-mono#3294](https://github.com/badlogic/pi-mono/issues/3294) asks for `expandPromptTemplates` on `sendUserMessage`, but it was auto-closed. Changelog has `pasteToEditor` and `getCommands` additions, but no `sendUserMessage` expansion option. |

## Upstream dispatch model

`AgentSession.prompt()` is the full pipeline:

1. If `expandPromptTemplates` and text starts `/`, call `_tryExecuteExtensionCommand(text)` (`agent-session.ts:967-980`).
2. Emit `input` event regardless of expansion gate (`agent-session.ts:984-1000`).
3. If `expandPromptTemplates`, run `_expandSkillCommand()` then `expandPromptTemplate()` (`agent-session.ts:1003-1008`).

`AgentSession.sendUserMessage()` bypasses 1 and 3 by hardcoding `expandPromptTemplates: false` (`agent-session.ts:1341-1347`). Bridge currently calls that at `pi-extensions/pi-session-bridge/extensions/session-bridge.ts:450`.

## Recommended implementation

Use a hybrid route:

- Plain text: keep existing `pi.sendUserMessage` path.
- `/skill:*` and loaded prompt templates: expand client-side using `pi.getCommands()` + `sourceInfo.path`, then call `pi.sendUserMessage(expandedText, options)`. This is deterministic, works with `deliverAs`, and avoids tmux.
- Other slash-prefixed text: dispatch through own tmux pane only after resolving pane via process parent chain. This covers extension commands, built-in interactive commands, and unknown slash commands that only the editor/TUI parser understands.
- Never use `tmux display-message` without `-t` for pane resolution; it can target the active client, as proven by the misroute.
- If own pane cannot be resolved, fail closed with an error response rather than sending raw slash text to the model.

Code sketch:

```ts
type SlashExpansion =
  | { expanded: true; kind: "skill" | "prompt"; command: string; text: string }
  | { expanded: false };

async function sendPrompt(...) {
  const content = command.content ?? command.message;
  const requested = normalizeDelivery(command.deliverAs ?? command.streamingBehavior, defaultDelivery);
  const idle = currentCtx?.isIdle?.() ?? true;
  const deliverAs = requested === "auto" ? (idle ? undefined : "steer") : requested === "now" ? undefined : requested;
  const options = deliverAs ? { deliverAs } : undefined;

  if (typeof content === "string" && content.startsWith("/")) {
    const expanded = expandLoadedSlashContent(content);
    if (expanded.expanded) {
      pi.sendUserMessage(expanded.text as never, options as never);
      sendResponse(client, id, commandName, true, {
        deliveredAs: deliverAs ?? "now",
        idleBeforeSend: idle,
        expandedAs: expanded.kind,
        expandedCommand: expanded.command,
      });
      return;
    }

    const paneId = await resolveOwnTmuxPaneByParentChain();
    await pasteAndSubmitToPane(paneId, content);
    sendResponse(client, id, commandName, true, {
      deliveredAs: "tmuxPane",
      idleBeforeSend: idle,
      paneId,
    });
    return;
  }

  pi.sendUserMessage(content as never, options as never);
  sendResponse(client, id, commandName, true, { deliveredAs: deliverAs ?? "now", idleBeforeSend: idle });
}

function expandLoadedSlashContent(text: string): SlashExpansion {
  const spaceIndex = text.indexOf(" ");
  const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
  const cmd = pi.getCommands().find((entry) => entry.name === commandName);
  const sourcePath = cmd?.sourceInfo?.path;
  if (!cmd || typeof sourcePath !== "string") return { expanded: false };

  if (cmd.source === "skill" && commandName.startsWith("skill:")) {
    const raw = fs.readFileSync(sourcePath, "utf8");
    const body = stripFrontmatter(raw).trim();
    const skillName = commandName.slice("skill:".length);
    const baseDir = path.dirname(sourcePath);
    const block = `<skill name="${skillName}" location="${sourcePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
    const args = argsString.trim();
    return { expanded: true, kind: "skill", command: commandName, text: args ? `${block}\n\n${args}` : block };
  }

  if (cmd.source === "prompt") {
    const raw = fs.readFileSync(sourcePath, "utf8");
    const body = stripFrontmatter(raw);
    return { expanded: true, kind: "prompt", command: commandName, text: substitutePromptArgs(body, parsePromptArgs(argsString)) };
  }

  return { expanded: false };
}

async function resolveOwnTmuxPaneByParentChain(): Promise<string> {
  const listed = await pi.exec("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"], { timeout: 1000 });
  if (listed.code !== 0) throw new Error(`tmux list-panes failed: ${listed.stderr}`);

  const ancestors = new Set<string>();
  let pid = String(process.pid);
  for (let i = 0; i < 40 && pid && pid !== "1"; i++) {
    ancestors.add(pid);
    const ps = await pi.exec("ps", ["-o", "ppid=", "-p", pid], { timeout: 1000 });
    pid = ps.stdout.trim();
  }

  for (const line of listed.stdout.split(/\r?\n/)) {
    const [panePid, paneId] = line.trim().split(/\s+/);
    if (ancestors.has(panePid) && /^%\d+$/.test(paneId)) return paneId;
  }
  throw new Error("Unable to resolve own tmux pane");
}

async function pasteAndSubmitToPane(paneId: string, text: string) {
  const buffer = `fd-bridge-${process.pid}-${Date.now()}`;
  await pi.exec("tmux", ["load-buffer", "-b", buffer, "-"], { input: text } as never);
  await pi.exec("tmux", ["paste-buffer", "-b", buffer, "-t", paneId, "-p"], { timeout: 1000 });
  await pi.exec("tmux", ["delete-buffer", "-b", buffer], { timeout: 1000 }).catch(() => undefined);
  await pi.exec("tmux", ["send-keys", "-t", paneId, "Enter"], { timeout: 1000 });
}
```

Implementation note: upstream `ExecOptions` currently has no `input` field (`exec.ts:8-17`). If bridge wants `load-buffer -`, either add a local `spawn` helper in the extension or use `send-keys -l` plus `send-keys Enter`. For arbitrary multi-line/special text, local `spawn("tmux", ["load-buffer", ...], { stdio: "pipe" })` is cleaner.

## Live test results

Test harness used temporary extensions under `/tmp/pi-bridge-slash-research` and fresh tmux windows. All test windows/processes were cleaned up after tests.

### A. `pasteToEditor` did not auto-submit

Patched bridge route:

```json
{
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "deliveredAs": "editorPaste", "idleBeforeSend": true }
}
```

Immediately after that, `pi-bridge history` only had startup state, no `input`, no `bridge_pong`, no `message_update`:

```json
{
  "events": [
    { "type": "event", "event": "bridge_start", "data": { "state": { "pid": 4136999, "cwd": "/tmp/pi-bridge-slash-research" } } }
  ]
}
```

After a real Enter was pressed in the target pane, probe command finally ran:

```json
{"event":"command","args":"paste-A1","idle":true,"editorText":""}
```

Conclusion: `pasteToEditor("/cmd\n")` pastes a newline into the editor buffer; it does not synthesize submit.

### B. Tmux pane resolution: unsafe method failed; parent-chain method works

Unsafe method result: `tmux display-message -p '#{pane_id}'` returned the active client pane and sent text into the parent tab. This method must never ship.

Safe parent-chain no-key-injection probe:

```json
{
  "event": "pane-resolution",
  "processPid": 4169076,
  "source": "extension",
  "idle": true,
  "chain": ["4169076", "4169020", "16466", "4666"],
  "matches": [["4169020", "%972", "pi-br-pane"]],
  "listed": "4057113 %331 pi\n3867825 %915 fish\n345211 %512 fish\n1272484 %626 π FlightdeckTS\n3884336 %916 π Pi Resume Extension History\n4085996 %949 pi\n4169020 %972 pi-br-pane\n"
}
```

Conclusion: own-pane resolution by ancestor PID works. Submit injection should be tested only after implementing this strict resolver.

### C. Client expansion works for skill and prompt template

`pi-bridge commands` exposed source metadata:

```json
{
  "name": "probe-template",
  "source": "prompt",
  "sourceInfo": { "path": "/tmp/pi-bridge-slash-research/prompts/probe-template.md" }
}
{
  "name": "skill:probe-skill",
  "source": "skill",
  "sourceInfo": { "path": "/tmp/pi-bridge-slash-research/skills/probe-skill/SKILL.md" }
}
```

Skill send response:

```json
{
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": {
    "deliveredAs": "now",
    "idleBeforeSend": true,
    "expandedAs": "skill",
    "expandedCommand": "skill:probe-skill"
  }
}
```

Probe observed expanded skill content, not raw `/skill:...`:

```json
{"event":"input","text":"<skill name=\"probe-skill\" location=\"/tmp/pi-bridge-slash-research/skills/probe-skill/SKILL.md\">\nReferences are relative to /tmp/pi-bridge-slash-research/skills/probe-skill.\n\n# Probe Skill\n\nPROBE_SKILL_BODY_UNIQUE\n</skill>\n\nskillArg","source":"extension","idle":true,"editorText":""}
{"event":"before_agent_start","prompt":"<skill name=\"probe-skill\" location=\"/tmp/pi-bridge-slash-research/skills/probe-skill/SKILL.md\">\nReferences are relative to /tmp/pi-bridge-slash-research/skills/probe-skill.\n\n# Probe Skill\n\nPROBE_SKILL_BODY_UNIQUE\n</skill>\n\nskillArg"}
```

Prompt-template send response:

```json
{
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": {
    "deliveredAs": "now",
    "idleBeforeSend": true,
    "expandedAs": "prompt",
    "expandedCommand": "probe-template"
  }
}
```

Probe observed expanded prompt content:

```json
{"event":"input","text":"\nPROBE_TEMPLATE_BODY_UNIQUE promptArg two\n","source":"extension","idle":true,"editorText":""}
{"event":"before_agent_start","prompt":"\nPROBE_TEMPLATE_BODY_UNIQUE promptArg two\n"}
```

Extension command under C stayed raw and did not dispatch:

```json
{
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "deliveredAs": "now", "idleBeforeSend": true }
}
{"event":"input","text":"/probe:cmd extArg","source":"extension","idle":true,"editorText":""}
{"event":"before_agent_start","prompt":"/probe:cmd extArg"}
{"event":"streamSimple","prompt":"/probe:cmd extArg\n"}
```

### D. Monkey-patch surface probe

```json
{
  "event": "factory",
  "frozen": false,
  "sendUserMessageDescriptor": { "writable": true, "enumerable": true, "configurable": true },
  "keys": ["on", "registerTool", "registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "getFlag", "sendMessage", "sendUserMessage", "appendEntry", "setSessionName", "getSessionName", "setLabel", "exec", "getActiveTools", "getAllTools", "setActiveTools", "getCommands", "setModel", "getThinkingLevel", "setThinkingLevel", "registerProvider", "unregisterProvider", "events"],
  "hasPrompt": false,
  "hasSession": false,
  "hasUnsafe": false
}
```

Conclusion: mutable object, but no reachable full `prompt()` and no useful hidden session handle.

## Edge cases and future issues

- `pasteToEditor` cannot submit; it is not a universal bridge delivery path.
- Tmux injection is universal but high blast radius if pane resolution is wrong. Use parent-chain resolver only, never current-client `display-message`.
- Tmux injection during active streaming/modal/tool rendering still needs isolated live tests after safe resolver lands. It should go through the same input queue as typed keys, but exact behavior for modal focus and busy state remains unverified.
- Client-side C expansion must track upstream semantics: prompt arg parsing, frontmatter stripping, collision precedence, `.agents/skills` ancestry, package resources, and `sourceInfo` paths. Using `pi.getCommands()` reduces drift.
- C expansion cannot invoke extension commands or built-in interactive commands because no public API exposes registered handlers or TUI slash parser.
- `pi.exec` cannot pass stdin today, so robust `tmux load-buffer -` needs local `child_process.spawn` in bridge or a future upstream `exec` input option.
- Unknown slash text should fail closed rather than be sent as a literal LLM prompt if universal dispatch mode is requested.
