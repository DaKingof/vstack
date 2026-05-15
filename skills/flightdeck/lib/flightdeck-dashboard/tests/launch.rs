use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

const SESSION: &str = "test-fd";
const SESSION_KEY: &str = "s42";

#[test]
fn launch_without_tmux_skips() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let output = Command::new(dashboard_bin())
        .args(["launch", "--session", SESSION, "--no-daemon"])
        .env_remove("TMUX")
        .env("FD_STATE_DIR", temp.path().join("runtime"))
        .env("FLIGHTDECK_STATE_DIR", temp.path().join("state"))
        .env("FLIGHTDECK_DASHBOARD", "1")
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("flightdeck-dashboard: not in tmux; skipping launch"));
    assert!(!temp.path().join("state").exists());
    Ok(())
}

#[test]
fn launch_disabled_exits_silently() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let output = Command::new(dashboard_bin())
        .args(["launch", "--session", SESSION])
        .env_remove("TMUX")
        .env("FD_STATE_DIR", temp.path().join("runtime"))
        .env("FLIGHTDECK_STATE_DIR", temp.path().join("state"))
        .env("FLIGHTDECK_DASHBOARD", "0")
        .output()?;

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
    assert!(!temp.path().join("state").exists());
    Ok(())
}

#[test]
fn launch_starts_rust_daemon_registers_window_and_is_idempotent() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let bin_dir = temp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let state_file = temp.path().join("flightdeck-state-test-fd.json");
    let runtime_dir = temp.path().join("runtime");
    let count_file = temp.path().join("session-count");
    let windows_file = temp.path().join("tmux-windows");
    write_state(&state_file, false)?;
    let tmux = write_fake_tmux(&bin_dir, &windows_file)?;
    let flightdeck_session =
        write_fake_flightdeck_session(&bin_dir, &state_file, &count_file, &windows_file)?;
    let path = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let first = launch_command(&path, &runtime_dir, &state_file, &flightdeck_session).output()?;
    assert!(
        first.status.success(),
        "first launch failed: {}",
        String::from_utf8_lossy(&first.stderr)
    );
    let pid_path = runtime_dir.join(format!("dashboard-{SESSION_KEY}.pid"));
    let socket_path = runtime_dir.join(format!("dashboard-{SESSION_KEY}.sock"));
    assert!(pid_path.exists(), "daemon pid file created");
    assert!(socket_path.exists(), "daemon socket created");
    let first_pid = std::fs::read_to_string(&pid_path)?;
    assert_eq!(std::fs::read_to_string(&count_file)?.trim(), "1");
    let entry = read_dashboard_entry(&state_file)?;
    assert_eq!(entry["kind"], "workflow");
    assert_eq!(entry["pane_id"], "%99");

    let second = launch_command(&path, &runtime_dir, &state_file, &flightdeck_session).output()?;
    assert!(
        second.status.success(),
        "second launch failed: {}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(std::fs::read_to_string(&count_file)?.trim(), "1");
    assert_eq!(std::fs::read_to_string(&pid_path)?, first_pid);

    let stop = Command::new(dashboard_bin())
        .args(["daemon", "stop", "--session", SESSION])
        .env("PATH", path)
        .env("TMUX", "/tmp/fake-tmux")
        .env("FD_STATE_DIR", &runtime_dir)
        .output()?;
    assert!(
        stop.status.success(),
        "daemon stop failed: {}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert!(tmux.exists(), "fake tmux installed");
    Ok(())
}

fn launch_command(
    path: &str,
    runtime_dir: &Path,
    state_file: &Path,
    flightdeck_session: &Path,
) -> Command {
    let mut command = Command::new(dashboard_bin());
    command
        .args([
            "launch",
            "--session",
            SESSION,
            "--state-file",
            state_file.to_str().expect("state path utf-8"),
            "--window-name",
            "flightdeck-test",
            "--motion",
            "off",
        ])
        .env("PATH", path)
        .env("TMUX", "/tmp/fake-tmux")
        .env("FD_STATE_DIR", runtime_dir)
        .env("FLIGHTDECK_DAEMON_RUST", "1")
        .env("FLIGHTDECK_SESSION_BIN", flightdeck_session)
        .env("FLIGHTDECK_DASHBOARD", "1");
    command
}

fn read_dashboard_entry(path: &Path) -> Result<Value, Box<dyn Error>> {
    let value = serde_json::from_str::<Value>(&std::fs::read_to_string(path)?)?;
    Ok(value
        .pointer("/entries/flightdeck-dashboard")
        .cloned()
        .ok_or("dashboard entry missing")?)
}

fn write_state(path: &Path, with_entry: bool) -> Result<(), Box<dyn Error>> {
    let entries = if with_entry {
        r#""flightdeck-dashboard":{"id":"flightdeck-dashboard","title":"flightdeck-test","kind":"workflow","state":"waiting","harness":"shell","pane_id":"%99"}"#
    } else {
        ""
    };
    let json = format!(
        r#"{{
  "session_id": "{SESSION}",
  "updated_at": "2026-05-15T00:00:00Z",
  "entries": {{{entries}}}
}}"#
    );
    std::fs::write(path, json)?;
    Ok(())
}

fn write_fake_tmux(dir: &Path, windows_file: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let path = dir.join("tmux");
    std::fs::write(
        &path,
        format!(
            r##"#!/usr/bin/env bash
set -euo pipefail
windows={windows:?}
if [[ "${{1:-}}" == "display-message" ]]; then
  args="$*"
  if [[ "$args" == *"#{{session_id}}"* ]]; then echo '$42'; exit 0; fi
  if [[ "$args" == *"#S"* ]]; then echo '{SESSION}'; exit 0; fi
  if [[ "$args" == *"#{{pane_id}}"* ]]; then echo '%99'; exit 0; fi
  exit 0
fi
if [[ "${{1:-}}" == "list-panes" ]]; then
  echo '%99'
  exit 0
fi
if [[ "${{1:-}}" == "list-windows" ]]; then
  [[ -f "$windows" ]] && cat "$windows"
  exit 0
fi
exit 0
"##,
            windows = windows_file.display()
        ),
    )?;
    make_executable(&path)?;
    Ok(path)
}

fn write_fake_flightdeck_session(
    dir: &Path,
    state_file: &Path,
    count_file: &Path,
    windows_file: &Path,
) -> Result<PathBuf, Box<dyn Error>> {
    let path = dir.join("flightdeck-session");
    std::fs::write(
        &path,
        format!(
            r##"#!/usr/bin/env bash
set -euo pipefail
state={state:?}
count_file={count:?}
windows={windows:?}
count=0
if [[ -f "$count_file" ]]; then count=$(cat "$count_file"); fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
title="flightdeck-test"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) title="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\n' "$title" >> "$windows"
cat > "$state" <<'JSON'
{{
  "session_id": "{SESSION}",
  "updated_at": "2026-05-15T00:00:01Z",
  "entries": {{
    "flightdeck-dashboard": {{
      "id": "flightdeck-dashboard",
      "title": "flightdeck-test",
      "kind": "workflow",
      "state": "waiting",
      "harness": "shell",
      "pane_id": "%99"
    }}
  }}
}}
JSON
"##,
            state = state_file.display(),
            count = count_file.display(),
            windows = windows_file.display()
        ),
    )?;
    make_executable(&path)?;
    Ok(path)
}

fn make_executable(path: &Path) -> Result<(), Box<dyn Error>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)?;
    }
    Ok(())
}

fn dashboard_bin() -> &'static str {
    env!("CARGO_BIN_EXE_flightdeck-dashboard")
}
