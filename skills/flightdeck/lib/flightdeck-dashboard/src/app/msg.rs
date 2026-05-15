use crossterm::event::KeyEvent;

use crate::app::model::ReadSourceState;
use crate::state::snapshot::{DashboardSnapshot, Event};
use crate::watcher::WatcherEvent;

#[derive(Debug)]
pub enum Msg {
    Tick,
    AnimateTick,
    KeyPressed(KeyEvent),
    Resize(u16, u16),
    SnapshotUpdated {
        snapshot: Box<DashboardSnapshot>,
        source_state: ReadSourceState,
    },
    EventReceived(Event),
    WatcherEvent(WatcherEvent),
    Error(String),
    Quit,
}
