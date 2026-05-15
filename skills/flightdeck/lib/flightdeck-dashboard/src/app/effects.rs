use tokio::sync::mpsc;

use crate::app::model::Clock;
use crate::fixtures;
use crate::state::tracked_entries;

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
                    let msg = match tokio::fs::read_to_string(&path).await {
                        Ok(source) => match tracked_entries::snapshot_from_str(&source, clock()) {
                            Ok(mut snapshot) => {
                                snapshot.master_state_path = path;
                                Msg::SnapshotUpdated(Box::new(snapshot))
                            }
                            Err(error) => Msg::Error(error.to_string()),
                        },
                        Err(error) => Msg::Error(format!(
                            "failed to read snapshot source {}: {error}",
                            path.display()
                        )),
                    };
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

fn send_msg(tx: &mpsc::UnboundedSender<Msg>, msg: Msg) {
    if tx.send(msg).is_err() {
        tracing::debug!("dashboard message receiver dropped");
    }
}
