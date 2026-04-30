# pi-qol

Quality-of-life extension for Pi.

Features:

- Intercepts distinguishable `Shift+Enter` / `Shift+Return` in the prompt editor and inserts a newline.
- Provides a configurable fallback newline key (`ctrl+j` by default) for terminals/tmux setups that collapse modified Enter into plain Enter. If a terminal reports Shift+Enter as Alt+Enter, move `app.message.followUp` to another key and bind `alt+enter` to `tui.input.newLine` in Pi keybindings.
- Styles `[Image #1]`, `[Image #2]`, ... placeholders as compact theme-aware chips in the editor.
- Collapses existing pasted image file paths to `[Image #N]` aliases and attaches those images on submit.
- Exposes a settings contract for hiding the collapsed `Thinking...` placeholder. Current Pi extension APIs do not expose assistant-message renderer replacement, so this setting is visible but cannot yet change built-in assistant rendering.

Commands:

- `/qol status`
- `/qol attachments`
- `/qol collapse`
- `/qol reset`

Known limitation: Pi owns native pending image attachment state and does not expose it to extensions. This package can attach image paths it collapses itself, but native Pi paste/drag attachments remain Pi-owned.
