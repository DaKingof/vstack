# prompt-stash

Per-session prompt stash history for Pi.

## Usage

- `Alt+S` with editor text: stash the current prompt and clear the editor.
- `Alt+S` with an empty editor: open the stash popup.
- `/prompt-stash`: open the stash popup.

Popup controls:

- Type to search.
- `↑/↓` or `j/k` to select.
- `Enter` to pop the selected prompt into the editor and remove it from the stash.
- `Ctrl+D` or `Delete` to delete the selected prompt.
- `Ctrl+X` to delete all stashed prompts, then `y` to confirm.
- `Esc` to close.

Stashes are stored per Pi session under `~/.pi/agent/vstack/prompt-stash/sessions/<session-id>/prompt-stash.json`, even when the extension is enabled by project settings. Legacy `.pi/prompt-stash.json` files are imported into the current session and removed on load/use.
