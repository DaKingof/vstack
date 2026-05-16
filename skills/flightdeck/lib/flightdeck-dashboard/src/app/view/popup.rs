use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::hitmap::{ClickAction, HitMap};
use crate::app::theme::Palette;

#[derive(Debug, Clone, Copy)]
pub enum PopupWidth {
    Auto,
    Fixed(u16),
    PercentOfFrame(u16),
}

#[derive(Debug, Clone, Copy)]
pub enum PopupHeight {
    Auto,
    Fixed(u16),
    PercentOfFrame(u16),
}

pub struct PopupChrome<'a> {
    pub title: &'a str,
    pub subtitle: Option<&'a str>,
    pub footer_hints: &'a [&'a str],
    pub width: PopupWidth,
    pub height: PopupHeight,
}

pub fn render_popup<F>(
    frame: &mut Frame<'_>,
    area: Rect,
    chrome: PopupChrome<'_>,
    theme: &Palette,
    hitmap: &mut HitMap,
    body: F,
) where
    F: FnOnce(&mut Frame<'_>, Rect, &mut HitMap),
{
    hitmap.push(area, ClickAction::CloseOverlay, 10);
    let popup = popup_rect(area, chrome.width, chrome.height);
    hitmap.push(popup, ClickAction::NoOp, 10);
    frame.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active())
        .style(theme.overlay_panel())
        .title(Span::styled(format!(" {} ", chrome.title), theme.title()));
    frame.render_widget(block, popup);

    let close = Rect::new(
        popup.x.saturating_add(popup.width.saturating_sub(6)),
        popup.y,
        5,
        1,
    );
    hitmap.push(close, ClickAction::CloseOverlay, 10);
    frame.render_widget(Paragraph::new("[ ✕ ]").style(theme.error()), close);

    let inner = Rect::new(
        popup.x.saturating_add(2),
        popup.y.saturating_add(1),
        popup.width.saturating_sub(4),
        popup.height.saturating_sub(2),
    );
    let subtitle_height = u16::from(chrome.subtitle.is_some());
    let footer_height = u16::from(!chrome.footer_hints.is_empty());
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(subtitle_height),
            Constraint::Min(1),
            Constraint::Length(footer_height),
        ])
        .split(inner);
    if let Some(subtitle) = chrome.subtitle {
        frame.render_widget(
            Paragraph::new(subtitle.to_owned()).style(theme.muted()),
            chunks[0],
        );
    }
    body(frame, chunks[1], hitmap);
    if !chrome.footer_hints.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                chrome.footer_hints.join("   "),
                theme.footer(),
            )))
            .alignment(Alignment::Center)
            .wrap(Wrap { trim: true }),
            chunks[2],
        );
    }
}

fn popup_rect(area: Rect, width: PopupWidth, height: PopupHeight) -> Rect {
    let width = match width {
        PopupWidth::Auto => area.width.saturating_mul(70) / 100,
        PopupWidth::Fixed(width) => width,
        PopupWidth::PercentOfFrame(percent) => area.width.saturating_mul(percent.min(100)) / 100,
    }
    .min(area.width.saturating_sub(2))
    .max(20);
    let height = match height {
        PopupHeight::Auto => area.height.saturating_mul(70) / 100,
        PopupHeight::Fixed(height) => height,
        PopupHeight::PercentOfFrame(percent) => area.height.saturating_mul(percent.min(100)) / 100,
    }
    .min(area.height.saturating_sub(2))
    .max(8);
    let x = area.x.saturating_add(area.width.saturating_sub(width) / 2);
    let y = area
        .y
        .saturating_add(area.height.saturating_sub(height) / 2);
    Rect::new(x, y, width, height)
}
