Output ONLY valid JSON — no markdown fences, no explanation before or after:

{
  "agent": "external-TARGET",
  "timestamp": "ISO_8601",
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
- Suggestions may exist even when verdict is "pass"
- location: file path with function/struct names in backticks — NO line numbers (they go stale)
- priority: 1=Urgent, 2=High, 3=Normal, 4=Low
- estimate: 1=hours, 2=half-day, 3=day, 4=2-3 days, 5=week+
- category: "fix" (apply in this PR) or "issue" (track separately)
- Only report genuine issues you are confident about. No speculative warnings. If the code is clean, return verdict "pass" with empty arrays.
