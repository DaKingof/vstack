---
title: Task Prefix Hierarchy
impact: CRITICAL
impactDescription: Agents process wrong tasks or miss delegated work
tags: del
---

## Task Prefix Hierarchy

**Impact: CRITICAL (Agents process wrong tasks or miss delegated work)**

| Context | Emoji | Example Subject | `taskPrefix` Value |
|---------|-------|-----------------|-------------------|
| Top-level workflow | (none) | `§ 1: Display Dashboard` | (none) |
| Nested sub-workflow (⤵) | `⤵` | `⏤⤵ /skill § 1: Identify Failures` | `⏤⤵ /skill` |
| Dev delegation | `🐲` | `⏤⏤🐲 dev-implement § 4: Implement` | `⏤⏤🐲 dev-implement` |
| TPM delegation | `🤹‍♂️` | `⏤⏤🤹‍♂️ tpm-roadmap § 1: Analyze` | `⏤⏤🤹‍♂️ tpm-roadmap` |
| Review delegation | `🐞` | `⏤⏤🐞 security-review § 1: Review` | `⏤⏤🐞 security-review` |
| QA delegation | `🪲` | `⏤⏤🪲 qa-review § 1: Set Up` | `⏤⏤🪲 qa-review` |
| Tracking (inline) | `🐲` | `⏤⏤🐲 backend: Fix CI lint` | `⏤⏤🐲 backend` |

The `taskPrefix` from `workflow-sections` JSON output must be used exactly in delegation messages — never hand-written. Agents filter by prefix + PENDING status.
