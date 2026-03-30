---
title: Delegation Patterns
impact: CRITICAL
impactDescription: Agents receive wrong delegation or miss work entirely
tags: del
---

## Delegation Patterns

**Impact: CRITICAL (Agents receive wrong delegation or miss work entirely)**

| Pattern | When | Flow |
|---------|------|------|
| Spawn + message | Fresh agents (dev, QA, review) | Create tasks → spawn (behavioral prompt) → send delegation message (task prefix) | start-worktree, review-pr, cycle-plan |
| Message only | Re-delegation to existing agents | Create tasks → send delegation message (task prefix) | dev-fix, ci-fix, review-pr-comments |
| Self-create | Agent without team context | Embed `workflow-sections` in delegation prompt | audit-issues (TPM agent) |
| Consultation | One-off sub-agent | Full instructions in prompt, no task machinery | roadmap-plan, research-issue, start § 3 |
