# Vstack Pi UI rules
- Popups: title in top border, `\x1b[32m`; tabs then blank line; search own full-width `toolPendingBg` row, `> [cursor]`, no hint text; footer owns key hints, `\x1b[33m`; active rows use `selectedBg`+text; matches `\x1b[31m`; no decorative cursor glyphs.
- Tool rendering: compact one-line calls; bold text label, accent target, muted metadata; tree children; status colors success/error/warning; raw output/diffs only when useful or expanded.
- Persistent banners below status line: framed widget, compact counts in header, tree rows, active item first, muted hints, collapse/clear when empty.
