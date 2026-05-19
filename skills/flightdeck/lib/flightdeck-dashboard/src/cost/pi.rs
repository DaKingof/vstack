use std::collections::HashSet;
use std::io;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{TimeZone, Utc};
use serde_json::Value;

use crate::state::snapshot::TrackedSession;

use super::{CostError, CostMetrics, CostSource};

const DEFAULT_HISTORY_EVENTS: &str = "25";
const DEFAULT_HISTORY_TIMEOUT_MS: u64 = 1_000;

#[derive(Debug, Default, Clone, Copy)]
pub struct PiSource;

impl CostSource for PiSource {
    fn name(&self) -> &'static str {
        "pi"
    }

    fn supports(&self, entry: &TrackedSession) -> bool {
        entry
            .harness
            .as_deref()
            .is_some_and(|harness| harness == "pi")
            || entry.adapter.pi_session_id.is_some()
            || entry.adapter.pi_bridge_pid.is_some()
    }

    fn poll(&mut self, entry: &TrackedSession) -> Result<CostMetrics, CostError> {
        let Some(pid) = entry.adapter.pi_bridge_pid else {
            return Err(CostError::Unavailable(
                "pi bridge metadata missing; waiting for bridge discovery".to_owned(),
            ));
        };
        let bridge = resolve_pi_bridge_bin().ok_or_else(|| {
            CostError::Unavailable("pi-bridge CLI not found for Pi usage polling".to_owned())
        })?;
        let limit = std::env::var("FLIGHTDECK_DASHBOARD_PI_HISTORY_EVENTS")
            .ok()
            .filter(|value| value.trim().parse::<u32>().is_ok())
            .unwrap_or_else(|| DEFAULT_HISTORY_EVENTS.to_owned());
        let timeout = pi_history_timeout();
        let output = run_with_timeout(
            Command::new(&bridge).args(["history", limit.as_str(), "--pid", &pid.to_string()]),
            timeout,
        )?
        .ok_or_else(|| {
            CostError::Unavailable(format!(
                "pi-bridge history timed out for pid {pid} after {}ms",
                timeout.as_millis()
            ))
        })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(CostError::Unavailable(if stderr.is_empty() {
                format!("pi-bridge history failed for pid {pid}")
            } else {
                format!("pi-bridge history failed for pid {pid}: {stderr}")
            }));
        }
        parse_history(&output.stdout)
    }
}

fn resolve_pi_bridge_bin() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PI_BRIDGE_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(path) = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join("pi-bridge"))
            .find(|candidate| candidate.is_file())
    }) {
        return Some(path);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".pi/agent/bin/pi-bridge"))
        .filter(|candidate| candidate.is_file())
}

fn pi_history_timeout() -> Duration {
    std::env::var("FLIGHTDECK_DASHBOARD_PI_HISTORY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_HISTORY_TIMEOUT_MS))
}

fn run_with_timeout(command: &mut Command, timeout: Duration) -> io::Result<Option<Output>> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map(Some);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn parse_history(bytes: &[u8]) -> Result<CostMetrics, CostError> {
    let value: Value = serde_json::from_slice(bytes)?;
    let events = value
        .pointer("/data/events")
        .and_then(Value::as_array)
        .ok_or_else(|| CostError::Parse("pi-bridge history missing data.events".to_owned()))?;
    let mut metrics = CostMetrics::default();
    let mut seen = HashSet::new();
    for event in events {
        if let Some(message) = event.pointer("/data/message") {
            ingest_message(message, &mut seen, &mut metrics);
        }
        if let Some(messages) = event.pointer("/data/messages").and_then(Value::as_array) {
            for message in messages {
                ingest_message(message, &mut seen, &mut metrics);
            }
        }
    }
    if metrics.has_usage() {
        Ok(metrics)
    } else {
        Err(CostError::Unavailable(
            "pi usage not observed in bridge history yet".to_owned(),
        ))
    }
}

fn ingest_message(message: &Value, seen: &mut HashSet<String>, metrics: &mut CostMetrics) {
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let Some(usage) = message.get("usage") else {
        return;
    };
    let key = message
        .get("responseId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            format!(
                "{}:{}:{}",
                message
                    .get("timestamp")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                message.get("model").and_then(Value::as_str).unwrap_or(""),
                usage
                    .get("totalTokens")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
            )
        });
    if !seen.insert(key) {
        return;
    }
    metrics.turns = metrics.turns.saturating_add(1);
    metrics.input_tokens = metrics.input_tokens.saturating_add(
        usage
            .get("input")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    );
    metrics.output_tokens = metrics.output_tokens.saturating_add(
        usage
            .get("output")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    );
    metrics.cache_read_tokens = metrics.cache_read_tokens.saturating_add(
        usage
            .get("cacheRead")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
    );
    metrics.cache_creation_tokens = metrics.cache_creation_tokens.saturating_add(
        usage
            .get("cacheWrite")
            .and_then(Value::as_u64)
            .or_else(|| usage.get("cacheCreation").and_then(Value::as_u64))
            .unwrap_or_default(),
    );
    metrics.cost_usd += usage
        .pointer("/cost/total")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    if let Some(model) = message.get("model").and_then(Value::as_str) {
        metrics.last_model = Some(model.to_owned());
    }
    if let Some(timestamp) = message.get("timestamp").and_then(Value::as_i64) {
        if let Some(ts) = Utc.timestamp_millis_opt(timestamp).single() {
            metrics.last_updated = Some(metrics.last_updated.map_or(ts, |old| old.max(ts)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_history_usage_is_summed_and_deduped() {
        let source = br#"{
          "data": { "events": [
            { "data": { "messages": [
              { "role": "assistant", "model": "gpt-5.5", "timestamp": 1779162821649,
                "responseId": "resp_a",
                "usage": { "input": 10, "output": 2, "cacheRead": 100, "cacheWrite": 5,
                  "cost": { "total": 0.25 } } },
              { "role": "assistant", "model": "gpt-5.5", "timestamp": 1779162821649,
                "responseId": "resp_a",
                "usage": { "input": 10, "output": 2, "cacheRead": 100, "cacheWrite": 5,
                  "cost": { "total": 0.25 } } },
              { "role": "assistant", "model": "gpt-5.5", "timestamp": 1779162821649,
                "responseId": "resp_a",
                "usage": { "input": 10, "output": 2, "cacheRead": 100, "cacheWrite": 5,
                  "cost": { "total": 0.25 } } }
            ] } },
            { "data": { "message":
              { "role": "assistant", "model": "gpt-5.5", "timestamp": 1779162822000,
                "responseId": "resp_b",
                "usage": { "input": 20, "output": 4, "cacheRead": 200,
                  "cost": { "total": 0.50 } } }
            } }
          ] }
        }"#;

        let metrics = parse_history(source).expect("usage parses");

        assert_eq!(metrics.turns, 2);
        assert_eq!(metrics.input_tokens, 30);
        assert_eq!(metrics.output_tokens, 6);
        assert_eq!(metrics.cache_read_tokens, 300);
        assert_eq!(metrics.cache_creation_tokens, 5);
        assert!((metrics.cost_usd - 0.75).abs() < f64::EPSILON);
        assert_eq!(metrics.last_model.as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn pi_history_command_timeout_returns_none() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 1; echo late"]);

        let output = run_with_timeout(&mut command, Duration::from_millis(25))
            .expect("timeout wrapper should not fail");

        assert!(output.is_none());
    }
}
