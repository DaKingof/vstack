## pi-questions — using the `question` tool

The `question` tool is the right way to ask the user for explicit clarification when the answer materially changes the plan. Pure prose questions in your reply are easier to miss and harder to act on.

When to use:
- The next action depends on a choice only the user can make (which file, which approach, which environment).
- The user's request is ambiguous in a way that prose paraphrasing would not resolve cleanly.
- You need confirmation before an irreversible or high-blast-radius action (deletes, force-pushes, sending external messages).

When NOT to use:
- A simple yes/no that fits naturally in conversation.
- Anything you can determine yourself by reading the code.
- Speculative "would you like me to also…" follow-ups — finish the asked work first.

Calling rules:
- Provide a clear `header`, `question` text per tab, and concise mutually-exclusive `options` with descriptive labels.
- Use `multiple: true` only when several answers can co-exist; default is single-select.
- Use `allowCustom: true` only when the option list may not cover the user's answer; the free-form answer comes back in that tab's `answers` array.
- Group related sub-questions as separate `questions[]` tabs in one call rather than chaining many tool calls.

After the call, the result tells you which labels were selected (or the custom text). Do not re-ask the same question — act on the answer.
