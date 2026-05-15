use ratatui::style::{Color, Modifier, Style};

use crate::state::snapshot::{SessionKind, SessionState};

#[derive(Debug, Clone, Copy)]
pub struct Palette {
    pub bg: Color,
    pub surface: Color,
    pub overlay: Color,
    pub selected_bg: Color,
    pub text: Color,
    pub subtle: Color,
    pub muted: Color,
    pub accent: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
    pub info: Color,
    pub secondary: Color,
    pub border_active: Color,
    pub border_inactive: Color,
    pub chrome: Color,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    Moon,
    Dawn,
    Pantera,
    System,
}

pub const MOON: Palette = Palette {
    bg: Color::Rgb(0x23, 0x21, 0x36),
    surface: Color::Rgb(0x2a, 0x27, 0x3f),
    overlay: Color::Rgb(0x39, 0x35, 0x52),
    selected_bg: Color::Rgb(0x44, 0x41, 0x5a),
    text: Color::Rgb(0xe0, 0xde, 0xf4),
    subtle: Color::Rgb(0x90, 0x8c, 0xaa),
    muted: Color::Rgb(0x6e, 0x6a, 0x86),
    accent: Color::Rgb(0xc4, 0xa7, 0xe7),
    success: Color::Rgb(0x9c, 0xcf, 0xd8),
    warning: Color::Rgb(0xf6, 0xc1, 0x77),
    error: Color::Rgb(0xeb, 0x6f, 0x92),
    info: Color::Rgb(0x3e, 0x8f, 0xb0),
    secondary: Color::Rgb(0xea, 0x9a, 0x97),
    border_active: Color::Rgb(0xc4, 0xa7, 0xe7),
    border_inactive: Color::Rgb(0x56, 0x52, 0x6e),
    chrome: Color::Rgb(0x90, 0x8c, 0xaa),
};

pub const DAWN: Palette = Palette {
    bg: Color::Rgb(0xfa, 0xf4, 0xed),
    surface: Color::Rgb(0xff, 0xfa, 0xf3),
    overlay: Color::Rgb(0xf2, 0xe9, 0xe1),
    selected_bg: Color::Rgb(0xdf, 0xda, 0xd9),
    text: Color::Rgb(0x57, 0x52, 0x79),
    subtle: Color::Rgb(0x79, 0x75, 0x93),
    muted: Color::Rgb(0x98, 0x93, 0xa5),
    accent: Color::Rgb(0x90, 0x7a, 0xa9),
    success: Color::Rgb(0x56, 0x94, 0x9f),
    warning: Color::Rgb(0xea, 0x9d, 0x34),
    error: Color::Rgb(0xb4, 0x63, 0x7a),
    info: Color::Rgb(0x28, 0x69, 0x83),
    secondary: Color::Rgb(0xd7, 0x82, 0x7e),
    border_active: Color::Rgb(0x90, 0x7a, 0xa9),
    border_inactive: Color::Rgb(0xce, 0xca, 0xcd),
    chrome: Color::Rgb(0x79, 0x75, 0x93),
};

pub const PANTERA: Palette = Palette {
    bg: Color::Rgb(0x20, 0x1f, 0x26),
    surface: Color::Rgb(0x2d, 0x2c, 0x35),
    overlay: Color::Rgb(0x3a, 0x39, 0x43),
    selected_bg: Color::Rgb(0x4d, 0x4c, 0x57),
    text: Color::Rgb(0xdf, 0xdb, 0xdd),
    subtle: Color::Rgb(0xbf, 0xbc, 0xc8),
    muted: Color::Rgb(0x85, 0x83, 0x92),
    accent: Color::Rgb(0x6b, 0x50, 0xff),
    success: Color::Rgb(0x00, 0xff, 0xb2),
    warning: Color::Rgb(0xf5, 0xef, 0x34),
    error: Color::Rgb(0xeb, 0x42, 0x68),
    info: Color::Rgb(0x00, 0xa4, 0xff),
    secondary: Color::Rgb(0xff, 0x60, 0xff),
    border_active: Color::Rgb(0x6b, 0x50, 0xff),
    border_inactive: Color::Rgb(0x4d, 0x4c, 0x57),
    chrome: Color::Rgb(0x60, 0x5f, 0x6b),
};

pub const SYSTEM: Palette = Palette {
    bg: Color::Reset,
    surface: Color::Reset,
    overlay: Color::Reset,
    selected_bg: Color::Reset,
    text: Color::Reset,
    subtle: Color::Gray,
    muted: Color::DarkGray,
    accent: Color::Cyan,
    success: Color::Green,
    warning: Color::Yellow,
    error: Color::Red,
    info: Color::Blue,
    secondary: Color::Magenta,
    border_active: Color::Cyan,
    border_inactive: Color::DarkGray,
    chrome: Color::Reset,
};

impl Theme {
    #[must_use]
    pub fn from_cli_or_env(cli: Option<&str>, env: Option<&str>) -> Self {
        if let Some(value) = cli.and_then(non_empty) {
            return parse_theme(value).unwrap_or_else(|| invalid_theme(value));
        }
        if let Some(value) = env.and_then(non_empty) {
            return parse_theme(value).unwrap_or_else(|| invalid_theme(value));
        }
        Self::Moon
    }

    #[must_use]
    pub const fn palette(self) -> &'static Palette {
        match self {
            Self::Moon => &MOON,
            Self::Dawn => &DAWN,
            Self::Pantera => &PANTERA,
            Self::System => &SYSTEM,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Moon => "moon",
            Self::Dawn => "dawn",
            Self::Pantera => "pantera",
            Self::System => "system",
        }
    }

    #[must_use]
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Moon => "Rose Pine Moon",
            Self::Dawn => "Rose Pine Dawn",
            Self::Pantera => "Pantera neon",
            Self::System => "System terminal palette",
        }
    }

    #[must_use]
    pub fn row_style_selected(self) -> Style {
        let palette = self.palette();
        match self {
            Self::Moon | Self::Dawn | Self::Pantera => Style::new()
                .fg(palette.text)
                .bg(palette.selected_bg)
                .add_modifier(Modifier::BOLD),
            Self::System => Style::new()
                .fg(palette.text)
                .bg(palette.bg)
                .add_modifier(Modifier::BOLD | Modifier::REVERSED),
        }
    }
}

impl Palette {
    #[must_use]
    pub const fn frame(self) -> Style {
        Style::new().fg(self.text).bg(self.bg)
    }

    #[must_use]
    pub fn title(self) -> Style {
        Style::new()
            .fg(self.accent)
            .bg(self.bg)
            .add_modifier(Modifier::BOLD)
    }

    #[must_use]
    pub const fn muted(self) -> Style {
        Style::new().fg(self.muted).bg(self.bg)
    }

    #[must_use]
    pub const fn status(self) -> Style {
        Style::new().fg(self.text).bg(self.bg)
    }

    #[must_use]
    pub fn status_label(self) -> Style {
        Style::new()
            .fg(self.info)
            .bg(self.bg)
            .add_modifier(Modifier::BOLD)
    }

    #[must_use]
    pub const fn border(self) -> Style {
        Style::new().fg(self.border_inactive).bg(self.bg)
    }

    #[must_use]
    pub const fn border_active(self) -> Style {
        Style::new().fg(self.border_active).bg(self.bg)
    }

    #[must_use]
    pub fn tab_active(self) -> Style {
        if self.selected_bg == Color::Reset {
            return Style::new()
                .fg(self.accent)
                .bg(self.bg)
                .add_modifier(Modifier::BOLD | Modifier::REVERSED);
        }
        Style::new()
            .fg(self.bg)
            .bg(self.accent)
            .add_modifier(Modifier::BOLD)
    }

    #[must_use]
    pub const fn tab_inactive(self) -> Style {
        Style::new().fg(self.subtle).bg(self.bg)
    }

    #[must_use]
    pub fn header(self) -> Style {
        Style::new()
            .fg(self.accent)
            .bg(self.bg)
            .add_modifier(Modifier::BOLD)
    }

    #[must_use]
    pub const fn footer(self) -> Style {
        Style::new().fg(self.subtle).bg(self.bg)
    }

    #[must_use]
    pub fn pause(self) -> Style {
        self.chip(self.warning)
    }

    #[must_use]
    pub fn error(self) -> Style {
        if self.bg == Color::Reset {
            return Style::new()
                .fg(self.error)
                .bg(self.bg)
                .add_modifier(Modifier::BOLD);
        }
        Style::new()
            .fg(self.bg)
            .bg(self.error)
            .add_modifier(Modifier::BOLD)
    }

    #[must_use]
    pub fn ok(self) -> Style {
        Style::new()
            .fg(self.success)
            .bg(self.bg)
            .add_modifier(Modifier::BOLD)
    }

    #[must_use]
    pub fn warning(self) -> Style {
        Style::new()
            .fg(self.warning)
            .bg(self.bg)
            .add_modifier(Modifier::BOLD)
    }

    #[must_use]
    pub fn info(self) -> Style {
        Style::new()
            .fg(self.info)
            .bg(self.bg)
            .add_modifier(Modifier::BOLD)
    }

    #[must_use]
    pub fn filter(self) -> Style {
        self.chip(self.warning)
    }

    #[must_use]
    pub fn kind_badge(self, kind: &SessionKind) -> Style {
        match kind {
            SessionKind::Adhoc => self.chip(self.info),
            SessionKind::Issue => self.chip(self.secondary),
            SessionKind::Workflow => self.chip(self.success),
            SessionKind::Other(_) => self.muted(),
        }
    }

    #[must_use]
    pub fn state(self, state: &SessionState) -> Style {
        match state {
            SessionState::Complete | SessionState::Merged | SessionState::Ready => self.ok(),
            SessionState::Waiting | SessionState::Prompting | SessionState::MergeReady => {
                self.warning()
            }
            SessionState::Submitting => self.info(),
            SessionState::Cancelled | SessionState::Aborted => self.subtle(),
            SessionState::Dead => self.error(),
            SessionState::Other(_) => self.muted(),
        }
    }

    #[must_use]
    fn subtle(self) -> Style {
        Style::new().fg(self.subtle).bg(self.bg)
    }

    #[must_use]
    fn chip(self, color: Color) -> Style {
        if self.bg == Color::Reset {
            return Style::new()
                .fg(color)
                .bg(self.bg)
                .add_modifier(Modifier::BOLD);
        }
        Style::new()
            .fg(self.bg)
            .bg(color)
            .add_modifier(Modifier::BOLD)
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn parse_theme(value: &str) -> Option<Theme> {
    match value.to_ascii_lowercase().as_str() {
        "moon" => Some(Theme::Moon),
        "dawn" => Some(Theme::Dawn),
        "pantera" => Some(Theme::Pantera),
        "system" => Some(Theme::System),
        _ => None,
    }
}

fn invalid_theme(value: &str) -> Theme {
    eprintln!("flightdeck-dashboard: warning: invalid theme '{value}'; using moon");
    Theme::Moon
}
