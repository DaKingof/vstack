use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::{PiConfig, PiStreamState};

const CLASSIFIER_TIMEOUT: Duration = Duration::from_secs(2);
const CLASSIFIER_STDOUT_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug)]
enum ClassifierError {
    Spawn(io::Error),
    Io(io::Error),
    StdinUnavailable,
    StdoutUnavailable,
    Timeout,
}

pub(super) async fn classify_text(
    config: &PiConfig,
    state: &mut PiStreamState,
    text: &str,
) -> String {
    if let Some(classifier) = std::env::var_os("FD_CLASSIFIER")
        .or_else(|| std::env::var_os("FLIGHTDECK_CLASSIFIER"))
        .map(PathBuf::from)
    {
        if !classifier.is_file() {
            warn_classifier_non_file_transition(state, config, &classifier);
            return fallback_classify_text(text);
        }
        state.last_classifier_non_file_path = None;
        match run_classifier(&classifier, text.as_bytes()).await {
            Ok(Some(tag)) => {
                state.last_classifier_spawn_error = None;
                return tag;
            }
            Ok(None) => {
                state.last_classifier_spawn_error = None;
            }
            Err(ClassifierError::Spawn(error)) => {
                warn_classifier_spawn_transition(state, config, &classifier, error.kind());
            }
            Err(ClassifierError::Io(error)) => {
                state.last_classifier_spawn_error = None;
                tracing::warn!(pane_id = %config.pane_id, classifier_path = %classifier.display(), error_kind = ?error.kind(), %error, "pi classifier io failed");
            }
            Err(ClassifierError::StdinUnavailable) => {
                state.last_classifier_spawn_error = None;
                tracing::warn!(pane_id = %config.pane_id, classifier_path = %classifier.display(), "pi classifier stdin unavailable; falling back to regex");
            }
            Err(ClassifierError::StdoutUnavailable) => {
                state.last_classifier_spawn_error = None;
                tracing::warn!(pane_id = %config.pane_id, classifier_path = %classifier.display(), "pi classifier stdout unavailable; falling back to regex");
            }
            Err(ClassifierError::Timeout) => {
                state.last_classifier_spawn_error = None;
                tracing::warn!(pane_id = %config.pane_id, classifier_path = %classifier.display(), timeout_ms = CLASSIFIER_TIMEOUT.as_millis(), "pi classifier timed out; falling back to regex");
            }
        }
    }
    fallback_classify_text(text)
}

async fn run_classifier(path: &Path, input: &[u8]) -> Result<Option<String>, ClassifierError> {
    let mut child = Command::new(path)
        .arg("--no-footer-gate")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(ClassifierError::Spawn)?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(ClassifierError::StdinUnavailable)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(ClassifierError::StdoutUnavailable)?;
    let input = input.to_owned();
    let write_task = tokio::spawn(async move {
        stdin.write_all(&input).await?;
        stdin.shutdown().await
    });
    let stdout_task = tokio::spawn(read_capped_stdout(stdout));

    let status = match tokio::time::timeout(CLASSIFIER_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            write_task.abort();
            stdout_task.abort();
            return Err(ClassifierError::Io(error));
        }
        Err(_) => {
            write_task.abort();
            stdout_task.abort();
            let _ = child.start_kill();
            return Err(ClassifierError::Timeout);
        }
    };
    log_write_task_result(write_task.await);
    let stdout = match stdout_task.await {
        Ok(Ok(stdout)) => stdout,
        Ok(Err(error)) => return Err(ClassifierError::Io(error)),
        Err(error) if error.is_cancelled() => Vec::new(),
        Err(error) => return Err(ClassifierError::Io(io::Error::other(error.to_string()))),
    };
    if !status.success() {
        return Ok(None);
    }
    let tag = String::from_utf8_lossy(&stdout).trim().to_owned();
    Ok((!tag.is_empty()).then_some(tag))
}

async fn read_capped_stdout(mut stdout: tokio::process::ChildStdout) -> Result<Vec<u8>, io::Error> {
    let mut out = Vec::new();
    let mut buf = [0_u8; 8192];
    loop {
        let read = stdout.read(&mut buf).await?;
        if read == 0 {
            return Ok(out);
        }
        let remaining = CLASSIFIER_STDOUT_MAX_BYTES.saturating_sub(out.len());
        if remaining > 0 {
            out.extend_from_slice(&buf[..read.min(remaining)]);
        }
    }
}

fn log_write_task_result(result: Result<Result<(), io::Error>, tokio::task::JoinError>) {
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(error = %error, "classifier stdin write failed"),
        Err(error) if error.is_cancelled() => {}
        Err(error) => tracing::warn!(error = %error, "classifier write task failed"),
    }
}

fn warn_classifier_non_file_transition(
    state: &mut PiStreamState,
    config: &PiConfig,
    classifier: &Path,
) {
    if state.last_classifier_non_file_path.as_deref() == Some(classifier) {
        return;
    }
    state.last_classifier_non_file_path = Some(classifier.to_path_buf());
    tracing::warn!(pane_id = %config.pane_id, classifier_path = %classifier.display(), "FD_CLASSIFIER is not a regular file; using regex fallback");
}

fn warn_classifier_spawn_transition(
    state: &mut PiStreamState,
    config: &PiConfig,
    classifier: &Path,
    error_kind: io::ErrorKind,
) {
    if state.last_classifier_spawn_error == Some(error_kind) {
        return;
    }
    state.last_classifier_spawn_error = Some(error_kind);
    tracing::warn!(pane_id = %config.pane_id, classifier_path = %classifier.display(), error_kind = ?error_kind, "pi classifier spawn failed; falling back to regex");
}

fn fallback_classify_text(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    if lower.contains("terminal-state") || lower.contains("please end the session") {
        return "terminal-state-reached".to_owned();
    }
    if lower.contains("force push")
        || lower.contains("force-push")
        || lower.contains("--force-with-lease")
    {
        return "force-push-prompt".to_owned();
    }
    if lower.contains("merge now")
        || lower.contains("merge-ready")
        || lower.contains("ready to merge")
    {
        return "merge-now".to_owned();
    }
    if lower.contains("cleanup")
        || lower.contains("delete worktree")
        || lower.contains("keep worktree")
    {
        return "cleanup-prompt".to_owned();
    }
    if lower.contains("rebase") && lower.contains("conflict") {
        return "rebase-multi-choice".to_owned();
    }
    if text.contains("[1]") && text.contains("[2]") {
        return "generic-multi-choice".to_owned();
    }
    if (lower.contains("allow") && lower.contains('?'))
        || lower.contains("permission to run")
        || lower.contains("approve this command")
    {
        return "bash-permission-prompt".to_owned();
    }
    "rendering".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_detects_merge_prompt() {
        assert_eq!(fallback_classify_text("Ready to merge now"), "merge-now");
    }
}
