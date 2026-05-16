use std::error::Error;

use serde_json::Value;

use super::common::pi_daemon::*;

#[tokio::test]
async fn pi_classifier_timeout_falls_back_to_regex() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  printf '{"type":"event","event":"message_end","data":{"message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Ready to merge now '
  head -c 200000 /dev/zero | tr '\0' 'x'
  printf '"}]}}}\n'
  exit 0
fi
exit 0
"#,
    )?;
    let classifier = write_fake_executable(
        temp.path(),
        "classifier",
        r#"
sleep 5
echo terminal-state-reached
"#,
    )?;

    let mut daemon = spawn_daemon(
        temp.path(),
        &state_file,
        &bridge,
        &[("FD_CLASSIFIER", classifier.as_path())],
    )
    .await?;

    let rows = wait_for_wake_rows(temp.path(), 1).await?;
    assert!(
        rows.iter()
            .any(|row| row.get("classifier_tag").and_then(Value::as_str) == Some("merge-now")),
        "timed-out classifier falls back to regex classifier"
    );

    daemon.stop();
    Ok(())
}

#[tokio::test]
async fn pi_classifier_non_file_path_warns_once_and_falls_back() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let missing_classifier = temp.path().join("missing-classifier");
    let xdg_state = temp.path().join("xdg-state");
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  echo '{"type":"event","event":"message_end","data":{"message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Ready to merge now"}]}}}'
  echo '{"type":"event","event":"message_end","data":{"message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Ready to merge now again"}]}}}'
  sleep 10
fi
exit 0
"#,
    )?;

    let mut daemon = spawn_daemon(
        temp.path(),
        &state_file,
        &bridge,
        &[
            ("FD_CLASSIFIER", missing_classifier.as_path()),
            ("XDG_STATE_HOME", xdg_state.as_path()),
        ],
    )
    .await?;

    let rows = wait_for_wake_rows(temp.path(), 2).await?;
    assert_eq!(
        rows.iter()
            .filter(|row| row.get("classifier_tag").and_then(Value::as_str) == Some("merge-now"))
            .count(),
        2,
        "non-file classifier falls back to regex for both messages"
    );

    daemon.stop();
    let log = read_dashboard_log(&xdg_state)?;
    assert_eq!(
        occurrence_count(
            &log,
            "FD_CLASSIFIER is not a regular file; using regex fallback"
        ),
        1,
        "non-file classifier warning is emitted once per stream state"
    );
    assert!(log.contains(missing_classifier.to_str().ok_or("path utf-8")?));
    Ok(())
}
