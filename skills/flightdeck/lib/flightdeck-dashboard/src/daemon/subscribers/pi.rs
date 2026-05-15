use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::daemon::wake::{apply_domain_guard, is_canonical_tag, WakeAppender, WakeEvent};

use super::{
    subscriber_pid_file, Subscriber, SubscriberContext, SubscriberError, SubscriberHandle,
};

const BG_TASK_CUSTOM_TYPE: &str = "vstack-background-tasks:event";
const BG_TASK_EXIT_TYPE: &str = "exit";
const SUBAGENT_COMPLETION_CUSTOM_TYPE: &str = "subagent-completion";
const INITIAL_RESTART_BACKOFF: Duration = Duration::from_millis(200);
const MAX_RESTART_BACKOFF: Duration = Duration::from_secs(2);
const TEXT_EXCERPT_BYTES: usize = 1024;
const CLASSIFIER_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub struct PiSubscriber;

impl Subscriber for PiSubscriber {
    fn spawn(ctx: SubscriberContext) -> Result<SubscriberHandle, SubscriberError> {
        let config = PiConfig::from_context(ctx)?;
        let pid_file = subscriber_pid_file(
            &config.paths.state_dir,
            &config.paths.session_key,
            &config.pane_id,
        );
        let join = tokio::spawn(async move {
            let lifecycle = SubscriberLifecycle::new(pid_file, config.pane_id.clone());
            run_with_restart(config, &lifecycle).await;
        });
        Ok(SubscriberHandle::new(join))
    }
}

#[derive(Debug, Clone)]
struct PiConfig {
    pane_id: String,
    entry_kind: String,
    bridge_bin: PathBuf,
    target: PiTarget,
    paths: crate::daemon::lifecycle::RuntimePaths,
    wake: WakeAppender,
}

impl PiConfig {
    fn from_context(ctx: SubscriberContext) -> Result<Self, SubscriberError> {
        if ctx
            .config
            .pi_session_id
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        {
            return Err(SubscriberError::Spawn(
                "missing adapter.pi_session_id".to_owned(),
            ));
        }
        let target = if let Some(socket) = ctx
            .config
            .pi_socket
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            PiTarget::Socket(socket.to_owned())
        } else {
            return Err(SubscriberError::Spawn(
                "missing adapter.pi_bridge_socket".to_owned(),
            ));
        };
        let bridge_bin = resolve_bridge_bin().ok_or_else(|| {
            SubscriberError::Spawn("pi-bridge binary not found (PI_BRIDGE_BIN/PATH)".to_owned())
        })?;
        Ok(Self {
            pane_id: ctx.config.pane_id,
            entry_kind: ctx.config.entry_kind,
            bridge_bin,
            target,
            paths: ctx.paths,
            wake: ctx.wake,
        })
    }
}

#[derive(Debug, Clone)]
enum PiTarget {
    Socket(String),
}

impl PiTarget {
    fn args(&self) -> [&str; 2] {
        match self {
            Self::Socket(socket) => ["--socket", socket.as_str()],
        }
    }
}

#[derive(Debug)]
struct PiStreamState {
    seen_qids: HashSet<String>,
    last_hash: Option<String>,
    compact_seen: bool,
    last_parse_error: Option<String>,
    last_classifier_spawn_error: Option<io::ErrorKind>,
    last_classifier_non_file_path: Option<PathBuf>,
}

impl PiStreamState {
    fn new() -> Self {
        Self {
            seen_qids: HashSet::new(),
            last_hash: None,
            compact_seen: false,
            last_parse_error: None,
            last_classifier_spawn_error: None,
            last_classifier_non_file_path: None,
        }
    }

    fn set_last_hash(&mut self, hash: String) -> bool {
        if self.last_hash.as_deref() == Some(hash.as_str()) {
            return false;
        }
        self.last_hash = Some(hash);
        true
    }
}

#[derive(Debug)]
enum BridgeEvent {
    Hello(Value),
    Question { request_id: String, payload: Value },
    BgTaskExit { task: Value, hash: String },
    AssistantText { text: String, hash: String },
    EmptyAfterCompactDeferred,
    Ignored,
}

#[derive(Debug)]
struct SubscriberLifecycle {
    pid_path: PathBuf,
    pane_id: String,
}

impl SubscriberLifecycle {
    fn new(pid_path: PathBuf, pane_id: String) -> Self {
        Self { pid_path, pane_id }
    }

    fn record_bridge_pid(&self, pid: Option<u32>) {
        let Some(pid) = pid else {
            tracing::debug!(pane_id = %self.pane_id, path = %self.pid_path.display(), "pi-bridge child pid unavailable");
            return;
        };
        if let Err(error) = std::fs::write(&self.pid_path, pid.to_string()) {
            tracing::debug!(pane_id = %self.pane_id, path = %self.pid_path.display(), %error, "failed to write pi subscriber pid marker");
        }
    }

    fn clear_pid(&self) {
        if let Err(error) = std::fs::remove_file(&self.pid_path) {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::debug!(pane_id = %self.pane_id, path = %self.pid_path.display(), %error, "failed to remove pi subscriber pid marker");
            }
        }
    }
}

impl Drop for SubscriberLifecycle {
    fn drop(&mut self) {
        self.clear_pid();
    }
}

async fn run_with_restart(config: PiConfig, lifecycle: &SubscriberLifecycle) {
    let mut backoff = INITIAL_RESTART_BACKOFF;
    loop {
        let mut state = PiStreamState::new();
        match run_stream_once(&config, &mut state, lifecycle).await {
            Ok(()) => tracing::warn!(pane_id = %config.pane_id, "pi subscriber stream exited"),
            Err(error) => {
                tracing::warn!(pane_id = %config.pane_id, %error, "pi subscriber stream failed")
            }
        }
        lifecycle.clear_pid();
        tracing::warn!(pane_id = %config.pane_id, delay_ms = backoff.as_millis(), "pi subscriber restarting");
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_RESTART_BACKOFF);
    }
}

async fn run_stream_once(
    config: &PiConfig,
    state: &mut PiStreamState,
    lifecycle: &SubscriberLifecycle,
) -> Result<(), std::io::Error> {
    let target = config.target.args();
    let mut child = Command::new(&config.bridge_bin)
        .arg("stream")
        .arg(target[0])
        .arg(target[1])
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    lifecycle.record_bridge_pid(child.id());
    let Some(stdout) = child.stdout.take() else {
        return Err(std::io::Error::other("pi-bridge stream stdout unavailable"));
    };
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        handle_line(config, state, &line).await;
    }
    let status = child.wait().await?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "pi-bridge stream exited with {status}"
        )));
    }
    Ok(())
}

async fn handle_line(config: &PiConfig, state: &mut PiStreamState, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    let value = match serde_json::from_str::<Value>(line) {
        Ok(value) => {
            state.last_parse_error = None;
            value
        }
        Err(error) => {
            warn_parse_transition(
                state,
                &config.pane_id,
                format!("{:?}", error.classify()),
                line,
            );
            return;
        }
    };
    match classify_bridge_event(&value, state) {
        BridgeEvent::Hello(value) => emit_open_questions(config, state, &value).await,
        BridgeEvent::Question {
            request_id,
            payload,
        } => emit_question(config, state, request_id, payload).await,
        BridgeEvent::BgTaskExit { task, hash } => {
            emit_wake(
                config,
                WakeEvent::bg_task_exit(config.pane_id.clone(), task, hash),
            )
            .await;
        }
        BridgeEvent::AssistantText { text, hash } => {
            let raw_tag = classify_text(config, state, &text).await;
            let guarded_tag = apply_domain_guard(&raw_tag, &config.entry_kind);
            if is_canonical_tag(&guarded_tag) {
                emit_wake(
                    config,
                    WakeEvent::assistant_text(
                        config.pane_id.clone(),
                        truncate_excerpt(text),
                        guarded_tag,
                        hash,
                    ),
                )
                .await;
            }
        }
        BridgeEvent::EmptyAfterCompactDeferred => {
            tracing::debug!(pane_id = %config.pane_id, "pi empty-after-compact detected but emission deferred until TS canonical tag set includes it");
        }
        BridgeEvent::Ignored => {}
    }
}

fn classify_bridge_event(value: &Value, state: &mut PiStreamState) -> BridgeEvent {
    if value.get("type").and_then(Value::as_str) == Some("bridge_hello") {
        return BridgeEvent::Hello(value.clone());
    }
    if !is_event(value) {
        return BridgeEvent::Ignored;
    }
    match value
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "session_compact" => {
            state.compact_seen = true;
            BridgeEvent::Ignored
        }
        "agent_end" if state.compact_seen && agent_end_content_empty(value) => {
            state.compact_seen = false;
            // P5-3 sequencing: keep the vstack#38 detection state machine, but
            // do not emit `pi-empty-after-compact` until the TS daemon's
            // canonical tag set includes it. Re-enable Rust emission in the
            // same release that updates TS delivery.
            BridgeEvent::EmptyAfterCompactDeferred
        }
        "question" if question_opened(value) => question_event(value),
        "message_end" => message_end_event(value, state),
        _ => BridgeEvent::Ignored,
    }
}

fn message_end_event(value: &Value, state: &mut PiStreamState) -> BridgeEvent {
    let message = value.pointer("/data/message").unwrap_or(&Value::Null);
    let custom_type = message
        .get("customType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if custom_type == BG_TASK_CUSTOM_TYPE
        && message
            .pointer("/details/eventType")
            .and_then(Value::as_str)
            == Some(BG_TASK_EXIT_TYPE)
    {
        let details = message.get("details").cloned().unwrap_or_else(|| json!({}));
        let task = details.get("task").cloned().unwrap_or_else(|| json!({}));
        let task_id = task.get("id").and_then(Value::as_str).unwrap_or_default();
        let status = task
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let exit_code = task
            .get("exitCode")
            .map(Value::to_string)
            .unwrap_or_else(|| "null".to_owned());
        let hash = sha12(&format!("{task_id}|{status}|{exit_code}"));
        if !state.set_last_hash(hash.clone()) {
            return BridgeEvent::Ignored;
        }
        return BridgeEvent::BgTaskExit { task, hash };
    }
    if custom_type == SUBAGENT_COMPLETION_CUSTOM_TYPE {
        return BridgeEvent::Ignored;
    }
    if message.get("role").and_then(Value::as_str) == Some("assistant")
        && !message
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
    {
        let Some(text) = message_text(message) else {
            return BridgeEvent::Ignored;
        };
        let hash = sha12(&text);
        if !state.set_last_hash(hash.clone()) {
            return BridgeEvent::Ignored;
        }
        return BridgeEvent::AssistantText { text, hash };
    }
    BridgeEvent::Ignored
}

async fn emit_open_questions(config: &PiConfig, state: &mut PiStreamState, value: &Value) {
    let Some(questions) = value
        .pointer("/data/questions")
        .or_else(|| value.pointer("/questions"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for question in questions {
        let request_id = question
            .get("requestId")
            .or_else(|| question.pointer("/request/id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if request_id.is_empty() || !state.seen_qids.insert(request_id.to_owned()) {
            continue;
        }
        let payload = question
            .get("request")
            .cloned()
            .unwrap_or_else(|| question.clone());
        let hash = sha12(request_id);
        emit_wake(
            config,
            WakeEvent::pi_question(config.pane_id.clone(), request_id.to_owned(), payload, hash),
        )
        .await;
    }
}

async fn emit_question(
    config: &PiConfig,
    state: &mut PiStreamState,
    request_id: String,
    payload: Value,
) {
    if !state.seen_qids.insert(request_id.clone()) {
        return;
    }
    let hash = sha12(&request_id);
    emit_wake(
        config,
        WakeEvent::pi_question(config.pane_id.clone(), request_id, payload, hash),
    )
    .await;
}

async fn emit_wake(config: &PiConfig, event: WakeEvent) {
    let tag = event.classifier_tag.clone();
    match config.wake.append_event(event) {
        Ok(true) => {
            tracing::info!(pane_id = %config.pane_id, classifier_tag = %tag, "pi wake event appended")
        }
        Ok(false) => {
            tracing::debug!(pane_id = %config.pane_id, classifier_tag = %tag, "pi wake event deduped")
        }
        Err(error) => {
            tracing::warn!(pane_id = %config.pane_id, classifier_tag = %tag, %error, "pi wake event append failed")
        }
    }
}

fn question_event(value: &Value) -> BridgeEvent {
    let request_id = value
        .pointer("/data/requestId")
        .or_else(|| value.pointer("/data/request/id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if request_id.is_empty() {
        return BridgeEvent::Ignored;
    }
    let payload = value
        .pointer("/data/request")
        .cloned()
        .unwrap_or_else(|| value.get("data").cloned().unwrap_or(Value::Null));
    BridgeEvent::Question {
        request_id: request_id.to_owned(),
        payload,
    }
}

fn is_event(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("event")
}

fn question_opened(value: &Value) -> bool {
    value.pointer("/data/action").and_then(Value::as_str) == Some("opened")
}

fn agent_end_content_empty(value: &Value) -> bool {
    let content = value
        .pointer("/data/content")
        .or_else(|| value.pointer("/data/message/content"));
    matches!(content, Some(Value::Array(items)) if items.is_empty())
}

fn message_text(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

async fn classify_text(config: &PiConfig, state: &mut PiStreamState, text: &str) -> String {
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
            Err(ClassifierError::Timeout) => {
                state.last_classifier_spawn_error = None;
                tracing::warn!(pane_id = %config.pane_id, classifier_path = %classifier.display(), timeout_ms = CLASSIFIER_TIMEOUT.as_millis(), "pi classifier timed out; falling back to regex");
            }
        }
    }
    fallback_classify_text(text)
}

#[derive(Debug)]
enum ClassifierError {
    Spawn(io::Error),
    Io(io::Error),
    StdinUnavailable,
    Timeout,
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
    let input = input.to_owned();
    let write_task = tokio::spawn(async move {
        stdin.write_all(&input).await?;
        stdin.shutdown().await
    });
    let output = match tokio::time::timeout(CLASSIFIER_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let _ = write_task.await;
            output
        }
        Ok(Err(error)) => {
            write_task.abort();
            return Err(ClassifierError::Io(error));
        }
        Err(_) => {
            write_task.abort();
            return Err(ClassifierError::Timeout);
        }
    };
    if !output.status.success() {
        return Ok(None);
    }
    let tag = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok((!tag.is_empty()).then_some(tag))
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

fn truncate_excerpt(text: String) -> String {
    if text.len() <= TEXT_EXCERPT_BYTES {
        return text;
    }
    let mut end = TEXT_EXCERPT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn sha12(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    format!("{:02x}", digest[0])
        + &digest[1..]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()[..10]
}

fn warn_parse_transition(state: &mut PiStreamState, pane_id: &str, kind: String, line: &str) {
    if state.last_parse_error.as_deref() == Some(kind.as_str()) {
        return;
    }
    state.last_parse_error = Some(kind.clone());
    let excerpt = line.chars().take(160).collect::<String>();
    tracing::warn!(pane_id = %pane_id, error_kind = %kind, excerpt = %excerpt, "malformed pi-bridge stream line");
}

fn resolve_bridge_bin() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PI_BRIDGE_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    let output = std::process::Command::new("bash")
        .args(["-lc", "command -v pi-bridge"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!path.is_empty()).then(|| PathBuf::from(path))
}
