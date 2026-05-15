use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::model::Model;
use crate::app::theme::Theme;

pub fn render(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let lines = vec![
        Line::from(Span::styled("Daemon — coming in Phase 4", theme.muted)),
        Line::from(""),
        Line::from(vec![
            Span::styled("snapshot diff drops ", theme.status_label),
            Span::raw(model.snapshot_diff_drops.to_string()),
        ]),
        Line::from(vec![
            Span::styled("read source ", theme.status_label),
            Span::raw(format!("{:?}", model.read_source_state)),
        ]),
    ];
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border)
        .title(Span::styled(" daemon scaffold ", theme.muted));
    frame.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
}
