---
title: Task Layers
impact: HIGH
impactDescription: Task list becomes unreadable, agents cannot find their work
tags: del
---

## Task Layers

**Impact: HIGH (Task list becomes unreadable, agents cannot find their work)**

The shared task list contains three visually distinct layers:

```
§ N: [Title]                → orchestrator's own workflow steps
⏤⤵ /cmd § N: [Title]      → nested sub-workflows
⏤⏤🐲/🤹‍♂️/🐞/🪲 workflow § N: [Title] → agent tasks
```

Agents filter by their prefix + PENDING status — they never touch orchestrator or sub-workflow tasks.
