//! Activity event sources for the Live feed tab.
//!
//! The activity-events plan can plug in `flightdeck-activity-<session>.jsonl`
//! by adding one more `EventSource` implementor that tails that file and
//! returns `mpsc::UnboundedReceiver<Event>` from `subscribe`; the TUI fan-in
//! and ring buffer do not need to change.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

use crate::state::snapshot::{ActivitySource, Event, EventImportance};

const TAIL_POLL_MS: u64 = 250;

pub trait EventSource: Send + 'static {
    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event>;
}

#[derive(Debug, Clone)]
pub struct DaemonLogSource {
    path: PathBuf,
}

impl DaemonLogSource {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[must_use]
    pub fn for_session(state_dir: &Path, session_key: &str) -> Self {
        Self::new(state_dir.join(format!("fd-daemon-{session_key}.log")))
    }
}

impl EventSource for DaemonLogSource {
    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        subscribe_tail(self.path.clone(), ActivitySource::Daemon)
    }
}

#[derive(Debug, Clone)]
pub struct PendingWakeSource {
    path: PathBuf,
}

impl PendingWakeSource {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[must_use]
    pub fn for_session(state_dir: &Path, session_key: &str) -> Self {
        Self::new(state_dir.join(format!("fd-wake-events-{session_key}.log")))
    }
}

impl EventSource for PendingWakeSource {
    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        subscribe_tail(self.path.clone(), ActivitySource::Wake)
    }
}

pub struct CompositeSource {
    sources: Vec<Box<dyn EventSource>>,
}

impl CompositeSource {
    #[must_use]
    pub fn new(sources: Vec<Box<dyn EventSource>>) -> Self {
        Self { sources }
    }
}

impl EventSource for CompositeSource {
    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded_channel();
        for source in &self.sources {
            let mut source_rx = source.subscribe();
            let tx = tx.clone();
            tokio::spawn(async move {
                while let Some(event) = source_rx.recv().await {
                    if tx.send(event).is_err() {
                        break;
                    }
                }
            });
        }
        rx
    }
}

#[must_use]
pub fn daemon_state_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("FD_STATE_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(runtime).join("flightdeck");
    }
    let uid = std::env::var("UID").unwrap_or_else(|_| "unknown".to_owned());
    PathBuf::from(format!("/tmp/flightdeck-{uid}"))
}

#[must_use]
pub fn session_key_from_name(session: &str) -> String {
    if session.starts_with('s') && session[1..].chars().all(|ch| ch.is_ascii_digit()) {
        return session.to_owned();
    }
    session.to_owned()
}

pub fn parse_jsonl_str(
    text: &str,
    default_source: ActivitySource,
    warn: &mut dyn FnMut(&str),
) -> Vec<Event> {
    text.lines()
        .enumerate()
        .filter_map(|(idx, line)| {
            parse_jsonl_line(line, default_source).unwrap_or_else(|error| {
                let message = format!(
                    "Warning: invalid activity JSONL line {}: {error}; skipping.",
                    idx + 1
                );
                tracing::warn!(message = %message, "activity parse warning");
                warn(&message);
                None
            })
        })
        .collect()
}

fn subscribe_tail(path: PathBuf, default_source: ActivitySource) -> mpsc::UnboundedReceiver<Event> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut offset = 0usize;
        let mut tick = tokio::time::interval(Duration::from_millis(TAIL_POLL_MS));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let Ok(text) = tokio::fs::read_to_string(&path).await else {
                offset = 0;
                continue;
            };
            if text.len() < offset {
                offset = 0;
            }
            let new_text = &text[offset..];
            offset = text.len();
            for event in parse_jsonl_str(new_text, default_source, &mut |_| {}) {
                if tx.send(event).is_err() {
                    return;
                }
            }
        }
    });
    rx
}

fn parse_jsonl_line(line: &str, default_source: ActivitySource) -> Result<Option<Event>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value = serde_json::from_str::<Value>(trimmed).map_err(|error| error.to_string())?;
    let Value::Object(object) = value else {
        return Err("event root is not an object".to_owned());
    };
    let ts = object
        .get("ts")
        .or_else(|| object.get("timestamp"))
        .and_then(Value::as_str)
        .and_then(parse_ts)
        .unwrap_or_else(Utc::now);
    let source = object
        .get("source")
        .or_else(|| object.get("kind"))
        .and_then(Value::as_str)
        .and_then(parse_source)
        .unwrap_or(default_source);
    let importance = object
        .get("importance")
        .or_else(|| object.get("level"))
        .and_then(Value::as_str)
        .map(parse_importance)
        .unwrap_or_else(|| default_importance(source));
    let message = object
        .get("message")
        .or_else(|| object.get("msg"))
        .or_else(|| object.get("text"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            object
                .get("tag")
                .and_then(Value::as_str)
                .map(|tag| format!("tag={tag}"))
        })
        .unwrap_or_else(|| compact_json(&Value::Object(object.clone())));
    Ok(Some(Event::new(ts, source, importance, message)))
}

fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn parse_source(value: &str) -> Option<ActivitySource> {
    match value.to_ascii_lowercase().as_str() {
        "daemon" => Some(ActivitySource::Daemon),
        "wake" | "wakeup" => Some(ActivitySource::Wake),
        "prompt" => Some(ActivitySource::Prompt),
        "state" => Some(ActivitySource::State),
        "decision" => Some(ActivitySource::Decision),
        "err" | "error" => Some(ActivitySource::Error),
        _ => None,
    }
}

fn parse_importance(value: &str) -> EventImportance {
    match value.to_ascii_lowercase().as_str() {
        "important" | "high" | "error" | "err" => EventImportance::Important,
        "medium" | "warn" | "warning" => EventImportance::Medium,
        _ => EventImportance::Low,
    }
}

const fn default_importance(source: ActivitySource) -> EventImportance {
    match source {
        ActivitySource::Error | ActivitySource::Prompt | ActivitySource::Decision => {
            EventImportance::Important
        }
        ActivitySource::Wake | ActivitySource::State => EventImportance::Medium,
        ActivitySource::Daemon => EventImportance::Low,
    }
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "activity event".to_owned())
}
