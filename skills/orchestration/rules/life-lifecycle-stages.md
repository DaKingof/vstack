---
title: Lifecycle Stages
impact: HIGH
impactDescription: Agent lifecycle confusion causes missed or duplicated work
tags: life
---

## Lifecycle Stages

**Impact: HIGH (Agent lifecycle confusion causes missed or duplicated work)**

```
1. TASKS        Orchestrator creates tasks via workflow-sections (no owner assignment)
2. SPAWN        Spawn agent with behavioral prompt → agent goes idle
3. DELEGATE     Send delegation message with task prefix
4. WORK         Agent wakes, finds PENDING tasks by prefix, sets in-progress, processes in ID order
5. RETURN       Last workflow section sends completion message to orchestrator
6. IDLE/REDEL   Agent goes idle — may receive new tasks + message for fix cycles
7. SHUTDOWN     Orchestrator sends shutdown request when all work complete
```
