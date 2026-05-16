use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration as StdDuration;

use flightdeck_dashboard::daemon::client::DaemonClient;
use nix::errno::Errno;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use serde_json::Value;
use tokio::time::{sleep, Duration, Instant};

pub const SESSION: &str = "s505";
pub const PANE_ID: &str = "%18";

pub struct DaemonGuard {
    child: Child,
    bin: &'static str,
    state_dir: PathBuf,
    session: String,
}

impl DaemonGuard {
    pub fn socket(&self) -> PathBuf {
        self.state_dir
            .join(format!("dashboard-{}.sock", self.session))
    }

    pub fn stop(&mut self) {
        self.stop_with_env(&[]);
    }

    pub fn stop_with_env(&mut self, extra_env: &[(&str, &str)]) {
        let mut command = Command::new(self.bin);
        command
            .args(["daemon", "stop", "--session", self.session.as_str()])
            .env("FD_STATE_DIR", &self.state_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (key, value) in extra_env {
            command.env(key, value);
        }
        if let Err(error) = command.status() {
            eprintln!("failed to stop daemon: {error}");
        }
        self.wait_for_exit();
    }

    pub fn wait_for_exit(&mut self) {
        for _ in 0..50 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(StdDuration::from_millis(100)),
                Err(error) => {
                    eprintln!("failed to poll daemon child: {error}");
                    return;
                }
            }
        }
        if let Err(error) = self.child.kill() {
            eprintln!("failed to kill daemon child: {error}");
        }
        if let Err(error) = self.child.wait() {
            eprintln!("failed to wait daemon child: {error}");
        }
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

pub async fn spawn_daemon(
    state_dir: &Path,
    state_file: &Path,
    bridge: &Path,
    extra_env: &[(&str, &Path)],
) -> Result<DaemonGuard, Box<dyn Error>> {
    spawn_daemon_with_gate(state_dir, state_file, bridge, true, extra_env).await
}

pub async fn spawn_daemon_with_gate(
    state_dir: &Path,
    state_file: &Path,
    bridge: &Path,
    gate: bool,
    extra_env: &[(&str, &Path)],
) -> Result<DaemonGuard, Box<dyn Error>> {
    let mut command = Command::new(dashboard_bin());
    command
        .args([
            "daemon",
            "start",
            "--session",
            SESSION,
            "--state-file",
            state_file.to_str().ok_or("state path must be utf-8")?,
        ])
        .env("FD_STATE_DIR", state_dir)
        .env("PI_BRIDGE_BIN", bridge)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if gate {
        command.env("FLIGHTDECK_DAEMON_RUST", "1");
    }
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let child = command.spawn()?;
    let guard = DaemonGuard {
        child,
        bin: dashboard_bin(),
        state_dir: state_dir.to_path_buf(),
        session: SESSION.to_owned(),
    };
    wait_for_socket(&guard.socket()).await?;
    Ok(guard)
}

pub async fn wait_for_socket(socket: &Path) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if socket.exists() && DaemonClient::connect(socket).await.is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("daemon socket did not become ready: {}", socket.display()).into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

pub async fn wait_for_wake_rows(
    state_dir: &Path,
    min_rows: usize,
) -> Result<Vec<Value>, Box<dyn Error>> {
    let path = wake_events_path(state_dir);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(body) = std::fs::read_to_string(&path) {
            let rows = body
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()?;
            if rows.len() >= min_rows {
                return Ok(rows);
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("timed out waiting for wake rows in {}", path.display()).into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

pub fn wake_events_path(state_dir: &Path) -> PathBuf {
    state_dir.join(format!("fd-wake-events-{SESSION}.log"))
}

pub fn wake_pending_path(state_dir: &Path) -> PathBuf {
    state_dir.join(format!("fd-wake-pending-{SESSION}"))
}

pub fn read_dashboard_log(xdg_state: &Path) -> Result<String, Box<dyn Error>> {
    let log_dir = xdg_state.join("flightdeck");
    let mut out = String::new();
    for entry in std::fs::read_dir(&log_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("flightdeck-dashboard.log") {
            out.push_str(&std::fs::read_to_string(entry.path())?);
        }
    }
    Ok(out)
}

pub fn occurrence_count(haystack: &str, needle: &str) -> usize {
    haystack.match_indices(needle).count()
}

pub async fn assert_no_wake_rows(
    state_dir: &Path,
    duration: Duration,
) -> Result<(), Box<dyn Error>> {
    let path = wake_events_path(state_dir);
    let deadline = Instant::now() + duration;
    loop {
        if let Ok(body) = std::fs::read_to_string(&path) {
            let rows = body
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()?;
            if !rows.is_empty() {
                return Err(format!("unexpected wake rows in {}: {rows:?}", path.display()).into());
            }
        }
        if Instant::now() >= deadline {
            return Ok(());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

pub fn subscriber_pid_path(state_dir: &Path) -> PathBuf {
    state_dir.join(format!("fd-pi-subscriber-{SESSION}-18.pid"))
}

pub async fn wait_for_file_text(path: &Path) -> Result<String, Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(body) = std::fs::read_to_string(path) {
            let body = body.trim().to_owned();
            if !body.is_empty() {
                return Ok(body);
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("timed out waiting for text in {}", path.display()).into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

pub async fn wait_for_path_absent(path: &Path) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if !path.exists() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("timed out waiting for path removal: {}", path.display()).into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

pub async fn wait_for_count(path: &Path, min_count: u32) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let count = std::fs::read_to_string(path)
            .ok()
            .and_then(|body| body.trim().parse::<u32>().ok())
            .unwrap_or_default();
        if count >= min_count {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("timed out waiting for bridge restart count {min_count}").into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

pub async fn wait_for_pid_dead(pid: u32) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if !pid_alive(pid) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let _ = signal::kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
            return Err(format!("pid {pid} remained alive after timeout").into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

pub fn pid_alive(pid: u32) -> bool {
    match signal::kill(Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(Errno::ESRCH) => false,
        Err(_) => true,
    }
}

pub fn parse_pid(text: &str) -> Result<u32, Box<dyn Error>> {
    Ok(text.trim().parse::<u32>()?)
}

pub fn write_state(path: &Path, kind: &str) -> Result<(), Box<dyn Error>> {
    let json = format!(
        r#"{{
  "session_id": "{SESSION}",
  "updated_at": "2026-05-15T00:00:00Z",
  "entries": {{
    "agent-1": {{
      "id": "agent-1",
      "title": "Pi agent",
      "kind": "{kind}",
      "state": "waiting",
      "harness": "pi",
      "pane_id": "{PANE_ID}",
      "adapter": {{
        "pi_bridge_pid": 12345,
        "pi_bridge_socket": "/tmp/fake-pi-bridge.sock",
        "pi_session_id": "pi-session-test"
      }}
    }}
  }}
}}"#
    );
    std::fs::write(path, json)?;
    Ok(())
}

pub fn write_empty_state(path: &Path) -> Result<(), Box<dyn Error>> {
    let json = format!(
        r#"{{
  "session_id": "{SESSION}",
  "updated_at": "2026-05-15T00:00:01Z",
  "entries": {{}}
}}"#
    );
    std::fs::write(path, json)?;
    Ok(())
}

pub fn write_fake_bridge(dir: &Path, body: &str) -> Result<PathBuf, Box<dyn Error>> {
    write_fake_executable(dir, "pi-bridge", body)
}

pub fn write_fake_executable(
    dir: &Path,
    name: &str,
    body: &str,
) -> Result<PathBuf, Box<dyn Error>> {
    let path = dir.join(name);
    std::fs::write(
        &path,
        format!("#!/usr/bin/env bash\nset -euo pipefail\n{body}\n"),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms)?;
    }
    Ok(path)
}

pub fn dashboard_bin() -> &'static str {
    env!("CARGO_BIN_EXE_flightdeck-dashboard")
}
