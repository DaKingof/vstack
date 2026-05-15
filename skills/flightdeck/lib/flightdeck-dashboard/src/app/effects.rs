use std::path::Path;

use chrono::{DateTime, Utc};
use tokio::sync::mpsc;

use crate::app::model::Clock;
use crate::fixtures;
use crate::state::snapshot::DashboardSnapshot;
use crate::state::tracked_entries::{self, ArchiveError, SessionResolution, SnapshotError};

use super::command::{Cmd, SnapshotSource};
use super::msg::Msg;

#[derive(Clone)]
pub struct Effects {
    tx: mpsc::UnboundedSender<Msg>,
    clock: Clock,
}

impl Effects {
    #[must_use]
    pub const fn new(tx: mpsc::UnboundedSender<Msg>, clock: Clock) -> Self {
        Self { tx, clock }
    }

    pub fn run_commands(&self, commands: Vec<Cmd>) {
        for command in commands {
            match command {
                Cmd::Render => {}
                Cmd::RequestSnapshot(source) => self.request_snapshot(source),
                Cmd::LogAction(action) => tracing::info!(action = %action, "dashboard action"),
                Cmd::Spawn(future) => self.spawn_msg(future),
            }
        }
    }

    fn request_snapshot(&self, source: SnapshotSource) {
        match source {
            SnapshotSource::Demo(name) => {
                let msg = match fixtures::load_demo_snapshot(name, (self.clock)()) {
                    Ok(snapshot) => Msg::SnapshotUpdated(Box::new(snapshot)),
                    Err(error) => Msg::Error(error.to_string()),
                };
                send_msg(&self.tx, msg);
            }
            SnapshotSource::File(path) => {
                let tx = self.tx.clone();
                let clock = self.clock;
                tokio::spawn(async move {
                    let msg = snapshot_file_msg(&path, clock());
                    send_msg(&tx, msg);
                });
            }
            SnapshotSource::Session(resolution) => {
                let tx = self.tx.clone();
                let clock = self.clock;
                tokio::spawn(async move {
                    let msg = snapshot_session_msg(&resolution, clock());
                    send_msg(&tx, msg);
                });
            }
        }
    }

    fn spawn_msg(&self, future: futures::future::BoxFuture<'static, Msg>) {
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let msg = future.await;
            send_msg(&tx, msg);
        });
    }
}

fn snapshot_file_msg(path: &Path, now: DateTime<Utc>) -> Msg {
    match tracked_entries::snapshot_from_file(path, now) {
        Ok(snapshot) => Msg::SnapshotUpdated(Box::new(snapshot)),
        Err(SnapshotError::PrePurgeState) => {
            Msg::SnapshotUpdated(Box::new(tracked_entries::snapshot_for_error_path(
                path,
                now,
                SnapshotError::PrePurgeState.to_string(),
                true,
            )))
        }
        Err(error) => Msg::Error(error.to_string()),
    }
}

fn snapshot_session_msg(resolution: &SessionResolution, now: DateTime<Utc>) -> Msg {
    match tracked_entries::read_session_snapshot(resolution, now) {
        Ok(snapshot) => Msg::SnapshotUpdated(Box::new(snapshot)),
        Err(SnapshotError::PrePurgeState) => {
            Msg::SnapshotUpdated(Box::new(tracked_entries::snapshot_for_error(
                &resolution.session,
                resolution.state_path.clone(),
                now,
                SnapshotError::PrePurgeState.to_string(),
                true,
            )))
        }
        Err(SnapshotError::Archive(ArchiveError::NoArchives { .. })) => {
            Msg::SnapshotUpdated(Box::new(DashboardSnapshot::empty_for_session(
                &resolution.session,
                resolution.state_path.clone(),
                now,
            )))
        }
        Err(error) => Msg::Error(error.to_string()),
    }
}

fn send_msg(tx: &mpsc::UnboundedSender<Msg>, msg: Msg) {
    if tx.send(msg).is_err() {
        tracing::debug!("dashboard message receiver dropped");
    }
}
