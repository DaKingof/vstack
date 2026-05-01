# pi-questions

Structured inline questions for Pi, with multi-tab categories and `pi-bridge` reply/reject support.

## What it provides

- `question` tool: asks the user one or more multiple-choice categories.
- `ctx.askQuestions(payload)`: extension API helper for other Pi extensions.
- Interactive UI that takes over the editor input area by default, matching opencode/Claude-style prompts.
- Optional legacy floating overlay mode via settings.
- Session-bridge integration: external controllers can list, answer, reject, and stream question events.
- Notifies `pi-qol` before prompts open (and emits `vstack:pi-questions:opened`) so terminal/tmux bell notifications work for both `question` tool and `ctx.askQuestions(...)` requests.

## Payload

```json
{
  "id": "que_example",
  "header": "Choose next action",
  "questions": [
    {
      "header": "Issue Missing",
      "question": "How should I proceed?",
      "options": [
        { "label": "Use current branch", "description": "Continue without a tracker issue." },
        { "label": "Stop here", "description": "Wait for operator guidance." }
      ],
      "multiple": false,
      "allowCustom": true,
      "customLabel": "Type issue ID"
    }
  ]
}
```

Result:

```json
{ "requestId": "que_example", "answers": [["Stop here"]] }
```

Cancellation/reject:

```json
{ "requestId": "que_example", "cancelled": true }
```

## Free-form answers

Set `allowCustom: true` on a tab to add a free-type row. Selecting that row opens an inline text editor; the submitted text is returned in that tab's answer array. Bridge callers may provide the same custom answer by passing any non-empty string for that tab when `allowCustom` is true. Extremely large result JSON is truncated to Pi's default 50KB/2000-line tool limit and saved to a temp file with the path included in the result.

Optional custom fields:

- `customLabel`: label for the free-type row. Default: `Type custom answer`.
- `customPlaceholder`: help text shown beside the custom row/editor.

## Interactive keys

- `←/→` or `Tab`: switch tabs
- `↑/↓` or `j/k`: move selection
- `Enter`: single-select picks row and advances; multi-select advances/submits; on the custom row, opens text input
- `Space`: toggles row in multi-select tabs; on the custom row, opens text input
- `Esc`: cancel the whole request, or leave text input when editing a custom answer

## Settings

Settings are exposed through `pi-extension-manager` under **Questions**.

- `renderMode`: `editor` (default) takes over the editor input area; `overlay` restores the old floating popup.
- `optionRows`: maximum visible option rows before scrolling. Editor mode no longer pads short lists with empty rows.
- `popupWidth` / `popupMaxHeight`: only used when `renderMode = overlay`.
- `defaultHeader`: fallback question title.
- `bridgeRepliesEnabled`: allow `pi-session-bridge` to answer/reject pending questions.

## Flightdeck-style bridge control

Requires `pi-session-bridge` in the same Pi runtime. The bridge stream emits question events:

```bash
pi-bridge stream --pid <PID>
```

List pending questions:

```bash
pi-bridge questions --pid <PID>
```

Answer a request:

```bash
pi-bridge answer --pid <PID> --request-id que_example --answers '[["Stop here"]]'
```

Reject a request:

```bash
pi-bridge reject --pid <PID> --request-id que_example
```
