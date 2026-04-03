# Audit

Deep examination of existing code — not changes, but the code as it is. Returns review-finding JSON.

## 1. Build Prompt

Identify target files/directories from user request. Read the code to understand scope, then write a prompt file to `tmp/second-opinion-prompt.md`:

<prompt_template>
You are a code auditor providing a cross-model second opinion. Examine the specified code for quality issues.

**Files to audit:**
[FILE_LIST — one per line]

Read each file. Focus on:
- Bugs and logic errors
- Security vulnerabilities (injection, auth bypass, data exposure)
- Race conditions and concurrency issues
- Resource leaks (file handles, connections, memory)
- Error handling gaps (silent failures, swallowed errors)
- Design problems (tight coupling, broken abstractions)

Skip: style preferences, naming opinions, documentation gaps.

Output ONLY valid JSON — no markdown fences, no explanation before or after:

{
  "agent": "external-[TARGET]",
  "timestamp": "[ISO_8601]",
  "verdict": "pass or action_required",
  "summary": "1-2 sentence summary of findings",
  "blockers": [
    {
      "id": 1,
      "title": "Concise issue title (5-10 words)",
      "location": "src/file.rs (`function_name`)",
      "description": "What the issue is",
      "recommendation": "How to fix it",
      "priority": 1,
      "estimate": 2
    }
  ],
  "suggestions": [
    {
      "id": 1,
      "title": "Concise issue title (5-10 words)",
      "location": "src/file.rs (`function_name`)",
      "description": "What could be improved",
      "recommendation": "How to improve it",
      "priority": 3,
      "estimate": 2,
      "category": "fix"
    }
  ],
  "questions": [],
  "qa_metadata": {}
}

Rules:
- verdict: "action_required" if 1+ items in blockers[], "pass" if blockers[] is empty
- location: file path with function/struct names in backticks — NO line numbers
- priority: 1=Urgent, 2=High, 3=Normal, 4=Low
- estimate: 1=hours, 2=half-day, 3=day, 4=2-3 days, 5=week+
- category: "fix" (apply in this PR) or "issue" (track separately)
- Only report genuine issues — no filler
</prompt_template>

## 2. Run Script

```bash
.agents/skills/second-opinion/scripts/second-opinion audit \
  --prompt tmp/second-opinion-prompt.md \
  --cwd [PROJECT_PATH] \
  --output tmp/audit-external-YYYYMMDD-HHMMSS.json
```

## 3. Present Results

Use the same output format as the review workflow — verdict table, blockers, suggestions. Omit empty sections.
