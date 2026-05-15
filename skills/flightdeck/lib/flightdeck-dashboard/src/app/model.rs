use std::collections::HashMap;
use std::time::Instant;

use chrono::{DateTime, Utc};

use crate::app::command::SnapshotSource;
use crate::app::view::fx::{EffectKind, EffectTarget};
use crate::state::snapshot::{DashboardSnapshot, TrackedSession};

pub type Clock = fn() -> DateTime<Utc>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tab {
    Overview,
    LiveFeed,
    Conversations,
    Merges,
    Decisions,
    Daemon,
}

impl Tab {
    pub const ALL: [Self; 6] = [
        Self::Overview,
        Self::LiveFeed,
        Self::Conversations,
        Self::Merges,
        Self::Decisions,
        Self::Daemon,
    ];

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::LiveFeed => "Live feed",
            Self::Conversations => "Conversations",
            Self::Merges => "Conflicts & merges",
            Self::Decisions => "Decisions",
            Self::Daemon => "Daemon",
        }
    }

    #[must_use]
    pub const fn placeholder(self) -> &'static str {
        match self {
            Self::Overview => "",
            Self::LiveFeed => "Live feed — coming in Phase 3",
            Self::Conversations => "Conversations — coming in Phase 3",
            Self::Merges => "Conflicts & merges — coming in Phase 3",
            Self::Decisions => "Decisions — coming in Phase 3",
            Self::Daemon => "Daemon — coming in Phase 4",
        }
    }

    #[must_use]
    pub fn index(self) -> usize {
        Self::ALL.iter().position(|tab| *tab == self).unwrap_or(0)
    }

    #[must_use]
    pub fn next(self) -> Self {
        let idx = self.index();
        Self::ALL[(idx + 1) % Self::ALL.len()]
    }

    #[must_use]
    pub fn previous(self) -> Self {
        let idx = self.index();
        let len = Self::ALL.len();
        Self::ALL[(idx + len - 1) % len]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotionLevel {
    Full,
    Reduced,
    Off,
}

impl MotionLevel {
    #[must_use]
    pub fn from_env() -> Self {
        if std::env::var_os("NO_MOTION").is_some() || std::env::var_os("NO_COLOR").is_some() {
            return Self::Off;
        }
        match std::env::var("FLIGHTDECK_DASHBOARD_MOTION") {
            Ok(value) if value.eq_ignore_ascii_case("off") => Self::Off,
            Ok(value) if value.eq_ignore_ascii_case("reduced") => Self::Reduced,
            _ => Self::Full,
        }
    }

    #[must_use]
    pub const fn allows_motion(self) -> bool {
        !matches!(self, Self::Off)
    }

    #[must_use]
    pub const fn allows_rich_motion(self) -> bool {
        matches!(self, Self::Full)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectInstance {
    pub kind: EffectKind,
    pub target: EffectTarget,
    pub started_frame: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UiFlags {
    pub compact: bool,
    pub filter_open: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModalState {
    None,
    Help,
}

#[derive(Debug)]
pub struct Model {
    pub current_tab: Tab,
    pub tabs_enabled: Vec<Tab>,
    pub snapshot: DashboardSnapshot,
    pub snapshot_source: SnapshotSource,
    pub now: DateTime<Utc>,
    pub motion: MotionLevel,
    pub motion_clock: Instant,
    pub active_effects: Vec<EffectInstance>,
    pub selection: HashMap<Tab, usize>,
    pub show_help: bool,
    pub modal: ModalState,
    pub ui: UiFlags,
    pub quit_requested: bool,
    pub error: Option<String>,
    pub clock: Clock,
    pub animate_frame: u64,
}

impl Model {
    #[must_use]
    pub fn new(
        snapshot: DashboardSnapshot,
        snapshot_source: SnapshotSource,
        motion: MotionLevel,
        clock: Clock,
    ) -> Self {
        let tabs_enabled = Tab::ALL.to_vec();
        let mut selection = HashMap::with_capacity(Tab::ALL.len());
        for tab in Tab::ALL {
            selection.insert(tab, 0);
        }
        Self {
            current_tab: Tab::Overview,
            tabs_enabled,
            snapshot,
            snapshot_source,
            now: clock(),
            motion,
            motion_clock: Instant::now(),
            active_effects: Vec::with_capacity(8),
            selection,
            show_help: false,
            modal: ModalState::None,
            ui: UiFlags {
                compact: false,
                filter_open: false,
            },
            quit_requested: false,
            error: None,
            clock,
            animate_frame: 0,
        }
    }

    pub fn refresh_now(&mut self) {
        self.now = (self.clock)();
    }

    #[must_use]
    pub fn selected_index(&self) -> usize {
        self.selection
            .get(&self.current_tab)
            .copied()
            .unwrap_or_default()
    }

    pub fn set_selected_index(&mut self, value: usize) {
        let max = self.max_selection_index();
        self.selection.insert(self.current_tab, value.min(max));
    }

    #[must_use]
    pub fn selected_session(&self) -> Option<&TrackedSession> {
        self.snapshot.sessions.get(self.selected_index())
    }

    #[must_use]
    pub fn max_selection_index(&self) -> usize {
        self.snapshot.sessions.len().saturating_sub(1)
    }

    pub fn clamp_selection(&mut self) {
        let current = self.selected_index();
        self.set_selected_index(current);
    }
}

pub fn utc_now() -> DateTime<Utc> {
    Utc::now()
}
