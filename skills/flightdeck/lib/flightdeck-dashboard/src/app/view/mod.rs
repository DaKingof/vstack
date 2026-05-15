pub mod conversations;
pub mod costs;
pub mod daemon;
pub mod decisions;
pub mod fx;
pub mod live_feed;
pub mod merges;
pub mod modals;
pub mod overview;
pub mod popup;

use chrono::{DateTime, Utc};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Tabs};
use ratatui::Frame;

use crate::app::command::SnapshotSource;
use crate::app::hitmap::{ClickAction, HitMap};
use crate::app::model::{Model, Tab};
use crate::app::theme::Palette;
use crate::cost::format_summary;
use crate::state::snapshot::Staleness;

pub fn render(frame: &mut Frame<'_>, model: &Model) {
    let mut hitmap = HitMap::default();
    render_with_hitmap(frame, model, &mut hitmap);
}

pub fn render_with_hitmap(frame: &mut Frame<'_>, model: &Model, hitmap: &mut HitMap) {
    hitmap.clear();
    let theme = model.palette();
    let area = frame.area();
    let pause_height = u16::from(model.snapshot.paused_for_user.is_some());
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(pause_height),
            Constraint::Length(3),
            Constraint::Min(3),
            Constraint::Length(2),
        ])
        .split(area);

    render_status(frame, chunks[0], model, theme, hitmap);
    render_pause_banner(frame, chunks[1], model, theme, hitmap);
    render_tabs(frame, chunks[2], model, theme, hitmap);
    render_body(frame, chunks[3], model, theme, hitmap);
    render_footer(frame, chunks[4], model, theme, hitmap);

    match model.modal {
        crate::app::model::ModalState::Help => {
            modals::render_help(frame, area, model, theme, hitmap)
        }
        crate::app::model::ModalState::ThemePicker => {
            modals::render_theme_picker(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::DecisionDetail => {
            modals::render_decision_detail(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::SessionDetail => {
            modals::render_session_detail(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::EventDetail => {
            modals::render_event_detail(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::FilterInput => {
            modals::render_filter_input(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::ConfirmAction => {
            modals::render_confirm(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::None => {}
    }
}

fn render_status(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let snapshot = &model.snapshot;
    let owner = owner_label(model);
    let elapsed = snapshot
        .started_at
        .map(|started| human_duration(started, model.now))
        .unwrap_or_else(|| String::from("unknown"));
    let daemon = daemon_label(model).to_owned();
    let kind_counts = format!(
        "Adhoc {} · Issue {} · Workflow {}",
        snapshot.counts.adhoc, snapshot.counts.issue, snapshot.counts.workflow
    );
    let staleness = match snapshot.staleness(model.now) {
        Staleness::Fresh => String::from("fresh"),
        Staleness::WarnAfter(age) => format!("stale-warn {}", duration_label(age)),
        Staleness::StaleAfter(age) => format!("stale-dead {}", duration_label(age)),
    };
    let cost_chip = format_summary(&model.cost_totals.grand);
    let theme_chip = format!("{} ▾", model.theme.as_str());
    let pause_chip = snapshot
        .paused_for_user
        .as_ref()
        .map(|_| String::from("paused"));

    let mut spans = vec![
        Span::styled(" Flightdeck ", theme.title()),
        Span::raw("  "),
        Span::styled("session ", theme.status_label()),
        Span::raw(snapshot.session_id.as_str()),
        Span::raw("  ·  "),
        Span::raw(owner),
        Span::raw("  ·  "),
        Span::styled(daemon.as_str().to_owned(), theme.muted()),
        Span::raw("  ·  "),
        Span::styled("uptime ", theme.status_label()),
        Span::raw(elapsed),
        Span::raw("  ·  "),
        Span::styled(kind_counts, theme.info()),
        Span::raw("  ·  "),
        Span::styled(staleness, theme.muted()),
    ];
    if snapshot.terminated {
        spans.push(Span::raw("  "));
        spans.push(Span::styled("✔ session complete", theme.ok()));
    }
    if model.is_observer() {
        spans.push(Span::raw("  "));
        spans.push(Span::styled("observer", theme.warning()));
    }
    if let Some(chip) = &pause_chip {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(chip.clone(), theme.pause()));
    }
    spans.push(Span::raw("  "));
    spans.push(Span::styled(cost_chip.clone(), theme.info()));
    if model.cost_totals.unhealthy_sources > 0 {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            format!(
                "{} cost source unhealthy",
                model.cost_totals.unhealthy_sources
            ),
            theme.warning(),
        ));
    }
    spans.push(Span::raw("  "));
    spans.push(Span::styled(theme_chip.clone(), theme.header()));
    if let Some(status) = &model.status_message {
        spans.push(Span::raw("  "));
        let style = if status.success {
            theme.ok()
        } else {
            theme.warning()
        };
        spans.push(Span::styled(status.message.clone(), style));
    }
    if let Some(error) = &model.error {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(format!("ERR {error}"), theme.error()));
    }

    let inner_x = area.x.saturating_add(1);
    let inner_y = area.y.saturating_add(1);
    if let Some(daemon_x) = header_chip_x(&spans, &daemon) {
        hitmap.push(
            Rect::new(
                inner_x.saturating_add(daemon_x),
                inner_y,
                daemon.len() as u16,
                1,
            ),
            ClickAction::SelectTab(Tab::Daemon),
            1,
        );
    }
    if let Some(chip) = &pause_chip {
        if let Some(pause_x) = header_chip_x(&spans, chip) {
            hitmap.push(
                Rect::new(
                    inner_x.saturating_add(pause_x),
                    inner_y,
                    chip.len() as u16,
                    1,
                ),
                ClickAction::JumpToPaused,
                1,
            );
        }
    }
    if let Some(cost_x) = header_chip_x(&spans, &cost_chip) {
        hitmap.push(
            Rect::new(
                inner_x.saturating_add(cost_x),
                inner_y,
                cost_chip.len() as u16,
                1,
            ),
            ClickAction::SelectTab(Tab::Costs),
            1,
        );
    }
    if let Some(theme_x) = header_chip_x(&spans, &theme_chip) {
        hitmap.push(
            Rect::new(
                inner_x.saturating_add(theme_x),
                inner_y,
                theme_chip.len() as u16,
                1,
            ),
            ClickAction::OpenThemePicker,
            1,
        );
    }
    hitmap.push(
        Rect::new(
            area.x.saturating_add(area.width.saturating_sub(14)),
            inner_y,
            area.width.min(14),
            1,
        ),
        ClickAction::OpenThemePicker,
        1,
    );

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active())
        .title(Span::styled(" Flightdeck ", theme.title()));
    frame.render_widget(
        Paragraph::new(Line::from(spans))
            .block(block)
            .style(theme.status()),
        area,
    );
}

fn render_pause_banner(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    if area.height == 0 {
        return;
    }
    let Some(pause) = &model.snapshot.paused_for_user else {
        return;
    };
    let entry_id = pause.entry_id.as_deref().unwrap_or("unknown-entry");
    let mut text = format!(" PAUSED FOR USER · {entry_id} · {}", pause.reason);
    if let Some(prompt) = pause
        .prompt_text
        .as_deref()
        .filter(|prompt| !prompt.is_empty())
    {
        text.push_str(" · ");
        text.push_str(&trim_for_header(prompt, 96));
    }
    hitmap.push(area, ClickAction::JumpToPaused, 1);
    frame.render_widget(Paragraph::new(text).style(theme.pause()), area);
}

fn render_tabs(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let labels = model
        .tabs_enabled
        .iter()
        .map(|tab| Line::from(Span::raw(model.tab_label(*tab))))
        .collect::<Vec<_>>();
    let fx_hint = fx::tab_switch_hint(model);
    let title = if fx_hint.is_empty() {
        String::from(" tabs ")
    } else {
        format!(" tabs {fx_hint} ")
    };
    let mut x = area.x.saturating_add(2);
    let y = area.y.saturating_add(1);
    for tab in &model.tabs_enabled {
        let width = u16::try_from(model.tab_label(*tab).chars().count()).unwrap_or(u16::MAX);
        hitmap.push(Rect::new(x, y, width, 1), ClickAction::SelectTab(*tab), 0);
        x = x.saturating_add(width.saturating_add(3));
    }
    let tabs = Tabs::new(labels)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(theme.border())
                .title(Span::styled(title, theme.muted())),
        )
        .select(model.selected_tab_position())
        .style(theme.tab_inactive())
        .highlight_style(theme.tab_active());
    frame.render_widget(tabs, area);
}

fn render_body(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    match model.current_tab {
        Tab::Overview => overview::render(frame, area, model, theme, hitmap),
        Tab::LiveFeed => live_feed::render(frame, area, model, theme, hitmap),
        Tab::Conversations => conversations::render(frame, area, model, theme, hitmap),
        Tab::Merges => merges::render(frame, area, model, theme, hitmap),
        Tab::Decisions => decisions::render(frame, area, model, theme, hitmap),
        Tab::Costs => costs::render(frame, area, model, theme, hitmap),
        Tab::Daemon => daemon::render(frame, area, model, theme, hitmap),
    }
}

fn render_footer(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let text = if model.ui.filter_open {
        let prefix = if model.feed_filter.error.is_some() {
            " regex invalid > "
        } else {
            " filter > "
        };
        push_footer_target(hitmap, area, 1, "/ filter", ClickAction::OpenFilter);
        Line::from(vec![
            Span::styled(prefix, theme.filter()),
            Span::styled(model.feed_filter.input.clone(), theme.filter()),
        ])
    } else {
        let noisy = if model.ui.hide_noise {
            "noise: hidden"
        } else {
            "noise: shown"
        };
        let filter = if model.feed_filter.pattern.is_empty() {
            "filter: off".to_owned()
        } else {
            format!("filter: {}", model.feed_filter.pattern)
        };
        let left =
            " ↹ tabs   j/k or ↑/↓ select   ⏎ detail   D prune   g focus   / filter   ⇧M compact   ? help   q quit";
        push_footer_target(
            hitmap,
            area,
            1,
            "↹ tabs",
            ClickAction::SelectTab(model.next_tab()),
        );
        push_footer_target(hitmap, area, 32, "⏎ detail", ClickAction::OpenDetail);
        push_footer_target(
            hitmap,
            area,
            43,
            "D prune",
            ClickAction::PromptPrune(model.selected_index()),
        );
        push_footer_target(
            hitmap,
            area,
            53,
            "g focus",
            ClickAction::PromptFocus(model.selected_index()),
        );
        push_footer_target(hitmap, area, 63, "/ filter", ClickAction::OpenFilter);
        push_footer_target(hitmap, area, 74, "⇧M compact", ClickAction::ToggleCompact);
        push_footer_target(hitmap, area, 87, "? help", ClickAction::OpenHelp);
        push_footer_target(hitmap, area, 96, "q quit", ClickAction::Quit);
        let right = format!("{noisy}  ·  {filter}");
        let padding = area
            .width
            .saturating_sub((left.chars().count() + right.chars().count()) as u16)
            .max(1) as usize;
        let line = format!("{left}{}{right}", " ".repeat(padding));
        let right_x = area
            .width
            .saturating_sub(right.chars().count() as u16)
            .saturating_add(area.x);
        push_rect_target(
            hitmap,
            Rect::new(right_x, area.y, noisy.chars().count() as u16, area.height),
            ClickAction::ToggleNoiseFilter,
        );
        let filter_x = right_x.saturating_add(noisy.chars().count() as u16 + 5);
        push_rect_target(
            hitmap,
            Rect::new(filter_x, area.y, filter.chars().count() as u16, area.height),
            ClickAction::OpenFilter,
        );
        Line::from(Span::styled(line, theme.footer()))
    };
    let mut paragraph = Paragraph::new(text).style(theme.footer());
    if model.ui.filter_open && model.feed_filter.error.is_some() {
        paragraph = paragraph.block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(theme.error()),
        );
    }
    frame.render_widget(paragraph, area);
}

fn header_chip_x(spans: &[Span<'_>], needle: &str) -> Option<u16> {
    let mut offset = 0usize;
    for span in spans {
        let value = span.content.as_ref();
        if value == needle {
            return u16::try_from(offset).ok();
        }
        offset = offset.saturating_add(value.chars().count());
    }
    None
}

fn push_footer_target(
    hitmap: &mut HitMap,
    area: Rect,
    column_offset: u16,
    label: &str,
    action: ClickAction,
) {
    let rect = Rect::new(
        area.x.saturating_add(column_offset),
        area.y,
        u16::try_from(label.chars().count()).unwrap_or(u16::MAX),
        area.height,
    );
    push_rect_target(hitmap, rect, action);
}

fn push_rect_target(hitmap: &mut HitMap, rect: Rect, action: ClickAction) {
    hitmap.push(rect, action, 1);
}

fn daemon_label(model: &Model) -> &str {
    if matches!(model.snapshot_source, SnapshotSource::Socket(_))
        || model.snapshot.daemon.label != "daemon: unknown"
    {
        model.snapshot.daemon.label.as_str()
    } else {
        "daemon: file-mode"
    }
}

fn owner_label(model: &Model) -> String {
    let Some(owner) = &model.snapshot.owner else {
        return String::from("unknown");
    };
    let harness = owner.harness.as_deref().unwrap_or("unknown");
    let cwd = owner
        .cwd
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| String::from("cwd?"));
    format!("Master {harness} at {cwd}")
}

fn trim_for_header(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let trimmed = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{trimmed}…")
    } else {
        trimmed
    }
}

fn duration_label(duration: std::time::Duration) -> String {
    let seconds = duration.as_secs();
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if hours > 0 {
        format!("{hours}h{minutes:02}m")
    } else if minutes > 0 {
        format!("{minutes}m")
    } else {
        format!("{seconds}s")
    }
}

pub(super) fn human_duration(start: DateTime<Utc>, end: DateTime<Utc>) -> String {
    let duration = end.signed_duration_since(start);
    let seconds = duration.num_seconds().max(0);
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if hours > 0 {
        format!("{hours}h{minutes:02}m")
    } else {
        format!("{minutes}m")
    }
}
