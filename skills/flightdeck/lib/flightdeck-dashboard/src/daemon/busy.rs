use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::util::paths::{fd_events_file, fd_session_lock, fd_wake_pending};

use super::wake::WakeEvent;

#[derive(Debug, Error)]
pub enum BusyError {
    #[error("busy-state io error at {path}: {source}", path = path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("busy-state JSON error at {path}: {source}", path = path.display())]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone)]
pub struct BusyPaths {
    pub session_lock: PathBuf,
    pub wake_pending: PathBuf,
    pub events_file: PathBuf,
}

impl BusyPaths {
    #[must_use]
    pub fn new(state_dir: &Path, session_key: &str) -> Self {
        Self {
            session_lock: fd_session_lock(state_dir, session_key),
            wake_pending: fd_wake_pending(state_dir, session_key),
            events_file: fd_events_file(state_dir, session_key),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WakePending {
    delivered_at: String,
    delivered_at_epoch: u64,
    master_pane_id: Option<String>,
    daemon_pid: u32,
    in_flight: Vec<WakePendingMarker>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct WakePendingMarker {
    pane_id: String,
    hash: String,
    tag: String,
    is_bell: bool,
}

pub fn record_wake_pending(paths: &BusyPaths, event: &WakeEvent) -> Result<(), BusyError> {
    let mut pending = read_wake_pending(&paths.wake_pending)?;
    pending.in_flight.push(WakePendingMarker {
        pane_id: event.pane_id.clone(),
        hash: event.hash.clone(),
        tag: event.classifier_tag.clone(),
        is_bell: false,
    });
    write_json_atomic(&paths.wake_pending, &pending)
}

pub fn clear_wake_pending(paths: &BusyPaths) -> Result<(), BusyError> {
    match fs::remove_file(&paths.wake_pending) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(BusyError::Io {
            path: paths.wake_pending.clone(),
            source,
        }),
    }
}

pub fn drain_events(paths: &BusyPaths, clear_pending: bool) -> Result<String, BusyError> {
    let body = match fs::read_to_string(&paths.events_file) {
        Ok(body) => body,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(source) => {
            return Err(BusyError::Io {
                path: paths.events_file.clone(),
                source,
            })
        }
    };
    match fs::remove_file(&paths.events_file) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(BusyError::Io {
                path: paths.events_file.clone(),
                source,
            })
        }
    }
    if clear_pending {
        clear_wake_pending(paths)?;
    }
    Ok(body)
}

pub fn with_session_lock<T>(
    paths: &BusyPaths,
    f: impl FnOnce() -> Result<T, BusyError>,
) -> Result<T, BusyError> {
    if let Some(parent) = paths.session_lock.parent() {
        fs::create_dir_all(parent).map_err(|source| BusyError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&paths.session_lock)
        .map_err(|source| BusyError::Io {
            path: paths.session_lock.clone(),
            source,
        })?;
    fs2::FileExt::lock_exclusive(&file).map_err(|source| BusyError::Io {
        path: paths.session_lock.clone(),
        source,
    })?;
    let result = f();
    if let Err(error) = fs2::FileExt::unlock(&file) {
        tracing::warn!(path = %paths.session_lock.display(), %error, "failed to unlock session lock");
    }
    result
}

fn read_wake_pending(path: &Path) -> Result<WakePending, BusyError> {
    let now = Utc::now();
    match fs::read_to_string(path) {
        Ok(body) => serde_json::from_str::<WakePending>(&body).or_else(|_| {
            let value = serde_json::from_str::<Value>(&body).map_err(|source| BusyError::Json {
                path: path.to_path_buf(),
                source,
            })?;
            let delivered_at = value
                .get("delivered_at")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| now.to_rfc3339());
            Ok(WakePending {
                delivered_at,
                delivered_at_epoch: value
                    .get("delivered_at_epoch")
                    .and_then(Value::as_u64)
                    .unwrap_or_else(epoch_now),
                master_pane_id: value
                    .get("master_pane_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                daemon_pid: value
                    .get("daemon_pid")
                    .and_then(Value::as_u64)
                    .and_then(|pid| u32::try_from(pid).ok())
                    .unwrap_or_else(std::process::id),
                in_flight: Vec::new(),
            })
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(new_wake_pending(now)),
        Err(source) => Err(BusyError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn new_wake_pending(now: DateTime<Utc>) -> WakePending {
    WakePending {
        delivered_at: now.to_rfc3339(),
        delivered_at_epoch: epoch_now(),
        master_pane_id: None,
        daemon_pid: std::process::id(),
        in_flight: Vec::new(),
    }
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), BusyError> {
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let body = serde_json::to_vec(value).map_err(|source| BusyError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    fs::write(&tmp, body).map_err(|source| BusyError::Io {
        path: tmp.clone(),
        source,
    })?;
    fs::rename(&tmp, path).map_err(|source| BusyError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn epoch_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}
