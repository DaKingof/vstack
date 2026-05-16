use std::error::Error;

use super::common::pi_daemon::*;

#[tokio::test]
async fn rust_wake_side_default_gate_off() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let count_file = temp.path().join("bridge-count");
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  printf '1\n' > "${FD_FAKE_COUNT:?}"
  echo '{"type":"bridge_hello"}'
  exit 0
fi
exit 0
"#,
    )?;

    let mut daemon = spawn_daemon_with_gate(
        temp.path(),
        &state_file,
        &bridge,
        false,
        &[("FD_FAKE_COUNT", count_file.as_path())],
    )
    .await?;

    let log = std::fs::read_to_string(temp.path().join(format!("dashboard-{SESSION}.log")))?;
    assert!(log.contains("rust wake side inactive"));
    assert!(!count_file.exists());

    daemon.stop();
    Ok(())
}
