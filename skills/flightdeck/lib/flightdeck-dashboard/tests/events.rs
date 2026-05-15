use chrono::{TimeZone, Utc};
use flightdeck_dashboard::events::{parse_jsonl_str, DaemonLogSource, EventSource};
use flightdeck_dashboard::state::snapshot::{ActivitySource, EventImportance};

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

#[tokio::test]
async fn daemon_log_source_emits_existing_jsonl() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let path = dir.path().join("fd-daemon-s1.log");
    tokio::fs::write(
        &path,
        "{\"ts\":\"2026-05-15T10:00:00Z\",\"message\":\"tick\"}\ninvalid\n",
    )
    .await
    .expect("fixture writes");

    let source = DaemonLogSource::new(path);
    let mut rx = source.subscribe();
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("event arrives")
        .expect("event exists");

    assert_eq!(event.source, ActivitySource::Daemon);
    assert_eq!(event.message, "tick");
}
