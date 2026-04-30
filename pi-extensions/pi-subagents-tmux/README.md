# pi-subagents-tmux

Pi package for delegating work to specialized agents from a running Pi session.

## What it provides

- `subagent` tool: delegate a task to one agent, many agents in parallel, or a sequential chain.
- Project/user agent discovery from `.pi/agents`, `.claude/agents`, and `~/.pi/agent/agents`.
- Persistent tmux panes for agents with `pane: true` frontmatter.
- Inbox/outbox handoff under `~/.pi/agent/vstack/pi-subagents-tmux/sessions/<session-id>/` so pane agents can receive tasks and report completions without writing session data into the project.
- Grid-style tmux layout: first subagent column splits from the main pane, up to three agents stack vertically; later columns rebalance to equal widths.
- Tmux pane border titles like `subagent:iced` for visual identification.

## Tool examples

Single task:

```json
{
  "agent": "rust",
  "task": "Inspect rust-core/src for panic-prone error handling and summarize findings."
}
```

Parallel tasks:

```json
{
  "tasks": [
    { "agent": "iced", "task": "Review the widget layout." },
    { "agent": "reviewer-test", "task": "Check test coverage gaps." }
  ]
}
```

Sequential chain:

```json
{
  "chain": [
    { "agent": "scout", "task": "Map the relevant files." },
    { "agent": "planner", "task": "Turn this into a plan: {previous}" }
  ]
}
```

Useful options:

- `agentScope`: `project` (default), `user`, or `both`.
- `cwd`: override working directory for a single task.
- `confirmProjectAgents`: prompt before using project-local agents.

## Persistent pane agents

Agents with frontmatter like this use a persistent tmux pane instead of one-shot JSON mode:

```yaml
---
name: iced
description: Iced UI specialist
tools: read, grep, find, ls, bash, edit, write
model: openai/gpt-5.5:xhigh
pane: true
---
```

The parent Pi session writes tasks to `~/.pi/agent/vstack/pi-subagents-tmux/sessions/<session-id>/inbox/<agent>/` and polls the matching `outbox/<agent>/` for completion JSON. Sessions, prompt copies, launcher scripts, inbox/outbox, processed files, and pane registries are isolated by Pi session ID and never stored under the project's `.pi/` directory. Completions are surfaced back into the main conversation automatically.

Persistent panes require running Pi inside tmux.

## Settings

`pi-extension-manager` exposes:

- `maxParallelTasks` and `maxConcurrency` for one-shot delegation limits.
- `collapsedItemCount` for compact result rendering.
- `completionPollMs` and `childInboxPollMs` for persistent pane polling intervals.
