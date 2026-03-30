---
title: Review Finding Schema
impact: MEDIUM
impactDescription: Orchestrator cannot parse agent review output
tags: rev
---

## Review Finding Schema

**Impact: MEDIUM (Orchestrator cannot parse agent review output)**

All review/QA agents output JSON:

```json
{
  "agent": "agent-name",
  "timestamp": "2026-01-14T03:30:00Z",
  "verdict": "pass|action_required",
  "summary": "1-2 sentence summary",
  "blockers": [{
    "id": 1, "title": "Title (5-10 words)",
    "location": "src/file.rs (`function_name`)",
    "description": "What the issue is",
    "recommendation": "How to fix it",
    "priority": 1, "estimate": 2
  }],
  "suggestions": [{
    "id": 1, "title": "Title (5-10 words)",
    "location": "src/file.rs (`function_name`)",
    "description": "What could be improved",
    "recommendation": "How to improve it",
    "priority": 3, "estimate": 2,
    "category": "fix|issue"
  }],
  "questions": [{
    "id": 1, "location": "src/file.rs",
    "question": "Why is this async?",
    "draft_response": "Because...",
    "source": "@reviewer",
    "source_id": "PRRT_kwDO...",
    "source_type": "inline"
  }],
  "qa_metadata": {}
}
```

Verdict: `action_required` if blockers exist, `pass` otherwise. Location uses function/struct names, never line numbers.
