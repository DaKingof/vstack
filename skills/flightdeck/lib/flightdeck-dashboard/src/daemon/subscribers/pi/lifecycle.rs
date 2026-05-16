use std::io;
use std::path::PathBuf;
use std::time::Duration;

use super::{run_stream_once, PiConfig, PiStreamState};

const INITIAL_RESTART_BACKOFF: Duration = Duration::from_millis(200);
const MAX_RESTART_BACKOFF: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub(super) struct SubscriberLifecycle {
    pid_path: PathBuf,
    pane_id: String,
}

impl SubscriberLifecycle {
    pub(super) fn new(pid_path: PathBuf, pane_id: String) -> Self {
        Self { pid_path, pane_id }
    }

    pub(super) fn record_bridge_pid(&self, pid: Option<u32>) {
        let Some(pid) = pid else {
            tracing::debug!(pane_id = %self.pane_id, path = %self.pid_path.display(), "pi-bridge child pid unavailable");
            return;
        };
        if let Err(error) = std::fs::write(&self.pid_path, pid.to_string()) {
            tracing::debug!(pane_id = %self.pane_id, path = %self.pid_path.display(), %error, "failed to write pi subscriber pid marker");
        }
    }

    fn clear_pid(&self) {
        if let Err(error) = std::fs::remove_file(&self.pid_path) {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::debug!(pane_id = %self.pane_id, path = %self.pid_path.display(), %error, "failed to remove pi subscriber pid marker");
            }
        }
    }
}

impl Drop for SubscriberLifecycle {
    fn drop(&mut self) {
        self.clear_pid();
    }
}

pub(super) async fn run_with_restart(config: PiConfig, lifecycle: &SubscriberLifecycle) {
    let mut backoff = INITIAL_RESTART_BACKOFF;
    loop {
        let mut state = PiStreamState::new();
        match run_stream_once(&config, &mut state, lifecycle).await {
            Ok(()) => tracing::warn!(pane_id = %config.pane_id, "pi subscriber stream exited"),
            Err(error) => {
                tracing::warn!(pane_id = %config.pane_id, %error, "pi subscriber stream failed")
            }
        }
        lifecycle.clear_pid();
        tracing::warn!(pane_id = %config.pane_id, delay_ms = backoff.as_millis(), "pi subscriber restarting");
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_RESTART_BACKOFF);
    }
}
