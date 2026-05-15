use chrono::Local;
use ratatui::layout::{Constraint, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Row, Table};
use ratatui::Frame;

use crate::app::model::Model;
use crate::app::motion::{Effect, EffectKind, EffectTarget};
use crate::app::theme::Theme;
use crate::state::snapshot::{Event, EventImportance};

pub fn render(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let events = model.filtered_events();
    let rows = events
        .iter()
        .take(area.height.saturating_sub(3) as usize)
        .enumerate()
        .map(|(idx, event)| row_for_event(event, idx, model, theme))
        .collect::<Vec<_>>();

    let title = format!(
        " activity feed · {} event{} · {} ",
        events.len(),
        if events.len() == 1 { "" } else { "s" },
        if model.ui.show_noisy {
            "noisy on"
        } else {
            "important only"
        }
    );
    let header = Row::new([
        Cell::from("Time"),
        Cell::from("Source"),
        Cell::from("!"),
        Cell::from("Message"),
    ])
    .style(theme.header);
    let table = Table::new(
        rows,
        [
            Constraint::Length(8),
            Constraint::Length(9),
            Constraint::Length(2),
            Constraint::Min(20),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(theme.border_active)
            .title(Span::styled(title, theme.title)),
    )
    .column_spacing(1);
    frame.render_widget(table, area);
}

fn row_for_event<'a>(event: &Event, idx: usize, model: &Model, theme: Theme) -> Row<'a> {
    let entered = is_active(model, EffectKind::ActivityRowEnter, EffectTarget::Row(idx));
    let flash = is_active(
        model,
        EffectKind::ActivityImportantFlash,
        EffectTarget::Row(idx),
    );
    let accent = if entered { "↳ " } else { "" };
    let time = event
        .ts
        .with_timezone(&Local)
        .format("%H:%M:%S")
        .to_string();
    let importance_style = match event.importance {
        EventImportance::Low => theme.muted,
        EventImportance::Medium => theme.warning,
        EventImportance::Important => theme.error,
    };
    let source_style = if flash {
        theme.error
    } else {
        theme.kind_badge(&crate::state::snapshot::SessionKind::Workflow)
    };
    Row::new(vec![
        Cell::from(time),
        Cell::from(Span::styled(event.source.as_chip(), source_style)),
        Cell::from(Span::styled(event.importance.dot(), importance_style)),
        Cell::from(Line::from(vec![
            Span::styled(accent.to_owned(), theme.info),
            Span::raw(event.message.clone()),
        ])),
    ])
    .style(if idx == model.selected_index() {
        theme.selection
    } else {
        theme.frame
    })
}

fn is_active(model: &Model, kind: EffectKind, target: EffectTarget) -> bool {
    model.active_effects.iter().any(|instance| {
        instance.kind == kind
            && instance.target == target
            && Effect::for_kind(kind).is_active(*instance, model.animate_frame)
    })
}
