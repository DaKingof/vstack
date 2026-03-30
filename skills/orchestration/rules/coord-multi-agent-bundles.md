---
title: Multi-Agent Bundles
impact: MEDIUM
impactDescription: Cross-domain work processed out of order
tags: coord
---

## Multi-Agent Bundles

**Impact: MEDIUM (Cross-domain work processed out of order)**

When sub-issues span domains:
- Groups processed sequentially per agent-sequencing rules
- Orchestrator collects handoff notes between groups
- All dev agents persist until shutdown (enables cross-domain fix cycles)
