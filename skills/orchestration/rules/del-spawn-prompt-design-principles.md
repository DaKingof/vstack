---
title: Spawn Prompt Design Principles
impact: CRITICAL
impactDescription: Agents ignore gate or process wrong messages
tags: del
---

## Spawn Prompt Design Principles

**Impact: CRITICAL (Agents ignore gate or process wrong messages)**

Spawn prompts are harness-specific — each platform has its own agent spawning mechanism. The patterns below are universal regardless of harness:

**Message gate**: Every agent must check incoming messages for a delegation marker (e.g., `Task prefix:` line) before acting. No marker → wait for delegation. This prevents agents from processing system notifications as work directives.

**PENDING-only filtering**: Agents only process unclaimed tasks matching their prefix. Completed tasks from prior rounds or other agents are ignored.

**Task ID ordering**: Process tasks in creation order (lowest ID first). Tasks are created in section order so IDs naturally match workflow progression.

**Skip-if handling**: Evaluate conditions literally, mark skipped tasks visibly so the orchestrator can track what was skipped.

**Single return**: The last task sends the completion message. No additional messages after — prevents double-wakeups.

**Verbatim templates**: Spawn prompts must be copied exactly (fill placeholders only). LLM paraphrasing drops critical behavioral instructions.

Full verbatim templates are in `workflows/spawn-prompts.md` — copy exactly, fill placeholders only.

---
