use ratatui::layout::{Alignment, Constraint, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Paragraph, Row, Table, Wrap};
use ratatui::Frame;

use crate::app::hitmap::{ClickAction, HitMap};
use crate::app::keymap::BINDINGS;
use crate::app::labels::{kind_label_for, state_label_for};
use crate::app::model::Model;
use crate::app::theme::{Palette, Theme};
use crate::app::view::popup::{render_popup, PopupChrome, PopupHeight, PopupWidth};

pub fn render_help(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let chrome = PopupChrome {
        title: "Help",
        subtitle: Some("Navigation, mouse support, and legend"),
        footer_hints: &["Esc/? close"],
        width: PopupWidth::PercentOfFrame(78),
        height: PopupHeight::PercentOfFrame(78),
    };
    render_popup(frame, area, chrome, theme, hitmap, |frame, body, _| {
        let mut lines = vec![
            Line::from(Span::styled("Navigation", theme.header())),
            Line::from("↹ tabs   j/k or ↑/↓ move between rows   Home/End jump"),
            Line::from(""),
            Line::from(Span::styled("Selection", theme.header())),
            Line::from("Enter opens the selected detail popup. Click a row to select; click selected row again for detail."),
            Line::from(""),
            Line::from(Span::styled("View toggles", theme.header())),
            Line::from("/ filter   Ctrl+N show noise   Alt+M compact   ? help   T theme"),
            Line::from(""),
            Line::from(Span::styled("Mouse", theme.header())),
            Line::from("Click tabs, rows, footer hints, the pause banner, daemon chip, or theme chip. Scroll inside tables to move selection."),
            Line::from(""),
            Line::from(Span::styled("Theme", theme.header())),
            Line::from("Open the theme picker with T or by clicking the theme chip in the header."),
        ];
        lines.extend(legend_lines(theme));
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("Keyboard", theme.header())));
        for binding in BINDINGS {
            lines.push(Line::from(vec![
                Span::styled(format!("{:<16}", binding.keys), theme.status_label()),
                Span::raw(binding.description),
            ]));
        }
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled("Theme: ", theme.status_label()),
            Span::raw(model.theme.as_str()),
            Span::raw(" ("),
            Span::raw(model.theme.display_name()),
            Span::raw(") · change with --theme dawn|system or FLIGHTDECK_DASHBOARD_THEME=..."),
        ]));
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), body);
    });
}

fn legend_lines(theme: &Palette) -> Vec<Line<'static>> {
    vec![
        Line::from(""),
        Line::from(Span::styled("Legend", theme.header())),
        Line::from("Kind badges     AH = Adhoc · ISS = Issue · WF = Workflow"),
        Line::from("State counts    P = Needs input · S = Submitting · W = Running · R = Idle"),
        Line::from("                MR = Ready to merge · M = Merged · C = Completed"),
        Line::from("                D = Stopped · CA = Cancelled · AB = Aborted"),
        Line::from("Status chips    fresh / stale-warn / stale-dead = how recent the state is"),
        Line::from("                file-mode = reading the state file directly; observer = different tmux pane than master"),
        Line::from("Spinners        Braille spinner next to a badge means transient work is being polled"),
        Line::from("PR / worktree   Pull Request number and local git worktree directory"),
    ]
}

pub fn render_theme_picker(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let chrome = PopupChrome {
        title: "Choose theme",
        subtitle: Some("set FLIGHTDECK_DASHBOARD_THEME=dawn to persist"),
        footer_hints: &["↑/↓ select", "Enter pick", "Esc close"],
        width: PopupWidth::Fixed(56),
        height: PopupHeight::Fixed(12),
    };
    render_popup(frame, area, chrome, theme, hitmap, |frame, body, hitmap| {
        let themes = [
            (Theme::Moon, "Rose Pine Moon", "dark"),
            (Theme::Dawn, "Rose Pine Dawn", "light"),
            (Theme::System, "System", "terminal ANSI"),
        ];
        let rows = themes
            .iter()
            .enumerate()
            .map(|(idx, (choice, name, desc))| {
                let radio = if *choice == model.theme { "●" } else { "○" };
                hitmap.push(
                    Rect::new(body.x, body.y.saturating_add(idx as u16), body.width, 1),
                    ClickAction::SelectTheme(*choice),
                    10,
                );
                Row::new([
                    Cell::from(Span::styled(radio, theme.header())),
                    Cell::from((*name).to_owned()),
                    Cell::from(format!("({desc})")),
                ])
                .style(if *choice == model.theme {
                    theme.selection()
                } else {
                    theme.frame()
                })
            })
            .collect::<Vec<_>>();
        frame.render_widget(
            Table::new(
                rows,
                [
                    Constraint::Length(3),
                    Constraint::Length(22),
                    Constraint::Min(12),
                ],
            ),
            body,
        );
    });
}

pub fn render_decision_detail(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let Some(decision) = super::decisions::selected_decision(model) else {
        render_message_popup(
            frame,
            area,
            "Decision",
            "No decision selected",
            theme,
            hitmap,
        );
        return;
    };
    let title = format!("Decision · {}", decision.entry_id);
    let subtitle = format!("{}  ·  {}", decision.prompt_tag, decision.ts.to_rfc3339());
    let chrome = PopupChrome {
        title: &title,
        subtitle: Some(&subtitle),
        footer_hints: &["Esc close", "↑/↓ scroll"],
        width: PopupWidth::PercentOfFrame(72),
        height: PopupHeight::PercentOfFrame(58),
    };
    render_popup(frame, area, chrome, theme, hitmap, |frame, body, _| {
        let lines = vec![
            Line::from(Span::styled("Answer", theme.header())),
            Line::from(decision.answer),
            Line::from(""),
            Line::from(Span::styled("Session", theme.header())),
            Line::from(format!("{} · {}", decision.entry_id, decision.title)),
        ];
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), body);
    });
}

pub fn render_session_detail(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let Some(session) = model.selected_session() else {
        render_message_popup(frame, area, "Session", "No session selected", theme, hitmap);
        return;
    };
    let subtitle = format!("{}  ·  {}", state_label_for(&session.state), session.id);
    let chrome = PopupChrome {
        title: &session.title,
        subtitle: Some(&subtitle),
        footer_hints: &["Esc close"],
        width: PopupWidth::PercentOfFrame(72),
        height: PopupHeight::PercentOfFrame(70),
    };
    render_popup(frame, area, chrome, theme, hitmap, |frame, body, _| {
        let mut lines = vec![
            Line::from(Span::styled("Overview", theme.header())),
            Line::from(format!(
                "{} · {} · {} · running for {}",
                kind_label_for(&session.kind),
                state_label_for(&session.state),
                session.harness.as_deref().unwrap_or("unknown harness"),
                super::human_duration(session.spawned_at.unwrap_or(model.now), model.now)
            )),
            Line::from(""),
            Line::from(Span::styled("Location", theme.header())),
            Line::from(format!(
                "pane {}",
                session.pane_id.as_deref().unwrap_or("—")
            )),
            Line::from(format!(
                "cwd {}",
                session
                    .cwd
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "—".to_owned())
            )),
        ];
        if let Some(issue) = session.issue() {
            lines.extend([
                Line::from(""),
                Line::from(Span::styled("Issue info", theme.header())),
                Line::from(format!(
                    "PR {} on remote",
                    issue
                        .pr_number
                        .map(|number| format!("#{number}"))
                        .unwrap_or_else(|| "—".to_owned())
                )),
                Line::from(format!(
                    "scope declared={} actual={}",
                    issue.scope_files_declared.unwrap_or_default(),
                    issue.scope_files_actual.unwrap_or_default()
                )),
            ]);
        }
        if let Some(pause) = &model.snapshot.paused_for_user {
            if pause.entry_id.as_deref().is_some_and(|id| id == session.id) {
                lines.extend([
                    Line::from(""),
                    Line::from(Span::styled("Paused", theme.header())),
                    Line::from(format!("reason: {}", pause.reason)),
                    Line::from(format!(
                        "prompt: {}",
                        pause.prompt_text.as_deref().unwrap_or("—")
                    )),
                ]);
            }
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("Recent decisions", theme.header())));
        for decision in session.decisions_log.iter().rev().take(3) {
            lines.push(Line::from(format!(
                "• {} → {}",
                decision.prompt_tag, decision.answer
            )));
        }
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), body);
    });
}

pub fn render_event_detail(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let Some(event) = model.filtered_events().get(model.selected_index()).copied() else {
        render_message_popup(frame, area, "Event", "No event selected", theme, hitmap);
        return;
    };
    let title = format!("Event · {}", event.source.as_chip());
    let subtitle = event.ts.to_rfc3339();
    let chrome = PopupChrome {
        title: &title,
        subtitle: Some(&subtitle),
        footer_hints: &["Esc close"],
        width: PopupWidth::PercentOfFrame(68),
        height: PopupHeight::PercentOfFrame(45),
    };
    render_popup(frame, area, chrome, theme, hitmap, |frame, body, _| {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled("Message", theme.header())),
                Line::from(event.message.clone()),
                Line::from(""),
                Line::from(format!("importance: {:?}", event.importance)),
            ])
            .wrap(Wrap { trim: true }),
            body,
        );
    });
}

pub fn render_filter_input(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let chrome = PopupChrome {
        title: "Filter sessions",
        subtitle: Some("matches session title and id; supports regex such as ^HT-"),
        footer_hints: &["Enter apply", "Esc cancel"],
        width: PopupWidth::PercentOfFrame(62),
        height: PopupHeight::Fixed(12),
    };
    render_popup(frame, area, chrome, theme, hitmap, |frame, body, hitmap| {
        let clear_rect = Rect::new(body.x, body.y.saturating_add(4), 20, 1);
        hitmap.push(clear_rect, ClickAction::ClearFilter, 10);
        let lines = vec![
            Line::from(Span::styled("Filter", theme.status_label())),
            Line::from(format!("> {}", model.feed_filter.input)),
            Line::from(""),
            Line::from(Span::styled("Clear filter", theme.warning())),
            Line::from(""),
            Line::from("The filter matches against session title and id; supports regex."),
        ];
        frame.render_widget(
            Paragraph::new(lines)
                .alignment(Alignment::Left)
                .wrap(Wrap { trim: true }),
            body,
        );
    });
}

fn render_message_popup(
    frame: &mut Frame<'_>,
    area: Rect,
    title: &str,
    message: &str,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let chrome = PopupChrome {
        title,
        subtitle: None,
        footer_hints: &["Esc close"],
        width: PopupWidth::Auto,
        height: PopupHeight::Auto,
    };
    render_popup(frame, area, chrome, theme, hitmap, |frame, body, _| {
        frame.render_widget(
            Paragraph::new(message.to_owned())
                .alignment(Alignment::Center)
                .wrap(Wrap { trim: true }),
            body,
        );
    });
}
