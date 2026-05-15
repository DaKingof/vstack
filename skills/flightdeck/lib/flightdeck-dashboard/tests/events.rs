use std::io::{self, Write};

use chrono::{TimeZone, Utc};
use flightdeck_dashboard::events::{
    parse_daemon_text_log_str, parse_jsonl_str, tail_read_error_event, DaemonTextLogSource,
    EventSource, JsonlEventSource,
};
use flightdeck_dashboard::state::snapshot::{ActivitySource, Event, EventImportance};

#[test]
fn parse_jsonl_skips_invalid_lines() {
    let source = r#"
{"ts":"2026-05-15T10:00:00Z","source":"daemon","importance":"low","message":"daemon started"}
not-json
{"ts":"2026-05-15T10:00:02Z","source":"wake","importance":"important","message":"wake delivered"}
[]
"#;
    let mut warnings = Vec::new();
    let mut warn = |message: &str| warnings.push(message.to_owned());

    let events = parse_jsonl_str(source, ActivitySource::Daemon, &mut warn);

    assert_eq!(events.len(), 2);
    assert_eq!(warnings.len(), 2);
    assert_eq!(events[0].source, ActivitySource::Daemon);
    assert_eq!(events[0].importance, EventImportance::Low);
    assert_eq!(events[0].message, "daemon started");
    assert_eq!(events[1].source, ActivitySource::Wake);
    assert_eq!(events[1].importance, EventImportance::Important);
    assert_eq!(
        events[1].ts,
        Utc.with_ymd_and_hms(2026, 5, 15, 10, 0, 2)
            .single()
            .expect("timestamp valid")
    );
}

#[test]
fn daemon_text_heartbeat_is_low_importance() {
    let source = "2026-05-15T00:06:41-07:00 [heartbeat] alive session_key=s3\n";
    let mut warnings = Vec::new();
    let mut warn = |message: &str| warnings.push(message.to_owned());

    let events = parse_daemon_text_log_str(source, &mut warn);

    assert!(warnings.is_empty());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].importance, EventImportance::Low);
    assert_eq!(events[0].message, "[heartbeat] alive session_key=s3");
}

#[test]
fn daemon_text_log_parses_known_lines() {
    let source = "2026-05-15T00:06:41-07:00 [start] pid=31853 session_id=$3 session_key=s3\n2026-05-15T00:06:42-07:00 [wake] delivered prompt to master\n";
    let mut warnings = Vec::new();
    let mut warn = |message: &str| warnings.push(message.to_owned());

    let events = parse_daemon_text_log_str(source, &mut warn);

    assert!(warnings.is_empty());
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].source, ActivitySource::Daemon);
    assert_eq!(events[0].importance, EventImportance::Low);
    assert_eq!(
        events[0].message,
        "[start] pid=31853 session_id=$3 session_key=s3"
    );
    assert_eq!(events[1].importance, EventImportance::Medium);
    assert_eq!(events[1].message, "[wake] delivered prompt to master");
}

#[tokio::test]
async fn jsonl_event_source_emits_existing_jsonl() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("fd-wake-events-s1.log");
    tokio::fs::write(
        &path,
        "{\"ts\":\"2026-05-15T10:00:00Z\",\"message\":\"tick\"}\ninvalid\n",
    )
    .await
    .expect("fixture writes");

    let source = JsonlEventSource::new(path, ActivitySource::Wake);
    let mut rx = source.subscribe();
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("event arrives")
        .expect("event exists");

    assert_eq!(event.source, ActivitySource::Wake);
    assert_eq!(event.message, "tick");
}

#[tokio::test]
async fn tail_handles_rotation() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("fd-wake-events-s1.log");
    tokio::fs::write(
        &path,
        "{\"ts\":\"2026-05-15T10:00:00Z\",\"message\":\"first\"}\n",
    )
    .await
    .expect("fixture writes");

    let source = JsonlEventSource::new(path.clone(), ActivitySource::Wake);
    let mut rx = source.subscribe();
    let first = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("first event arrives")
        .expect("first event exists");
    assert_eq!(first.message, "first");

    tokio::fs::remove_file(&path)
        .await
        .expect("old file removed");
    tokio::fs::write(
        &path,
        "{\"ts\":\"2026-05-15T10:00:01Z\",\"message\":\"rotated\"}\n",
    )
    .await
    .expect("rotated fixture writes");

    let rotated = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("rotated event arrives")
        .expect("rotated event exists");
    assert_eq!(rotated.message, "rotated");
}

#[tokio::test]
async fn tail_handles_invalid_utf8() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("fd-wake-events-s1.log");
    tokio::fs::write(
        &path,
        b"\xff\xfe\n{\"ts\":\"2026-05-15T10:00:00Z\",\"message\":\"valid\"}\n",
    )
    .await
    .expect("fixture writes");

    let source = JsonlEventSource::new(path, ActivitySource::Wake);
    let mut rx = source.subscribe();
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("event arrives")
        .expect("event exists");
    assert_eq!(event.message, "valid");
}

#[tokio::test]
async fn tail_carries_partial_lines_across_chunks() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("fd-wake-events-s1.log");
    let large_message = "x".repeat(300 * 1024);
    let body = format!(
        "{{\"ts\":\"2026-05-15T10:00:00Z\",\"message\":\"{large_message}\"}}\n{{\"ts\":\"2026-05-15T10:00:01Z\",\"message\":\"small\"}}\n"
    );
    tokio::fs::write(&path, body)
        .await
        .expect("large fixture writes");

    let source = JsonlEventSource::new(path, ActivitySource::Wake);
    let mut rx = source.subscribe();
    let large = recv_event(&mut rx).await;
    let small = recv_event(&mut rx).await;

    assert_eq!(large.message, large_message);
    assert_eq!(small.message, "small");
}

#[tokio::test]
async fn tail_truncates_oversize_record_with_warning() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("fd-wake-events-s1.log");
    tokio::fs::write(&path, vec![b'x'; 2 * 1024 * 1024])
        .await
        .expect("oversize fixture writes");

    let source = JsonlEventSource::new(path.clone(), ActivitySource::Wake);
    let mut rx = source.subscribe();
    let error = recv_event(&mut rx).await;
    assert_eq!(error.source, ActivitySource::Error);
    assert!(error.message.contains("record too large; truncating"));

    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append opens");
    writeln!(
        file,
        "\n{{\"ts\":\"2026-05-15T10:00:02Z\",\"message\":\"after truncate\"}}"
    )
    .expect("normal record appends");

    let normal = recv_event(&mut rx).await;
    assert_eq!(normal.message, "after truncate");
}

#[tokio::test]
async fn daemon_text_log_source_emits_existing_text_log() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("fd-daemon-s1.log");
    tokio::fs::write(
        &path,
        "2026-05-15T00:06:41-07:00 [start] pid=31853 session_id=$3\n",
    )
    .await
    .expect("fixture writes");

    let source = DaemonTextLogSource::new(path);
    let mut rx = source.subscribe();
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("event arrives")
        .expect("event exists");

    assert_eq!(event.source, ActivitySource::Daemon);
    assert_eq!(event.message, "[start] pid=31853 session_id=$3");
}

async fn recv_event(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Event>) -> Event {
    tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .expect("event arrives")
        .expect("event exists")
}

#[test]
fn tail_read_error_event_emits_once_per_kind_transition() {
    let path = std::path::Path::new("/tmp/nope.log");
    let permission = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
    let interrupted = io::Error::new(io::ErrorKind::Interrupted, "interrupted");
    let mut last_error_kind = None;

    let first = tail_read_error_event(path, &permission, &mut last_error_kind)
        .expect("first error emits event");
    let second = tail_read_error_event(path, &permission, &mut last_error_kind);
    let third = tail_read_error_event(path, &interrupted, &mut last_error_kind)
        .expect("kind transition emits event");

    assert_eq!(first.source, ActivitySource::Error);
    assert_eq!(first.importance, EventImportance::Important);
    assert!(first.message.contains("denied"));
    assert!(second.is_none());
    assert!(third.message.contains("interrupted"));
}
