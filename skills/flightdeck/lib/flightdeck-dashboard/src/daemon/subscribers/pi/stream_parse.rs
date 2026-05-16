use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

use super::PiStreamState;

pub(super) const MAX_BRIDGE_LINE: usize = 1024 * 1024;
const BG_TASK_CUSTOM_TYPE: &str = "vstack-background-tasks:event";
const BG_TASK_EXIT_TYPE: &str = "exit";
const SUBAGENT_COMPLETION_CUSTOM_TYPE: &str = "subagent-completion";
const SUBAGENT_COMPLETION_EVENT_TYPE: &str = "subagent-completion";
const PI_AGENTS_TMUX_CUSTOM_TYPE: &str = "vstack-pi-agents-tmux:event";
#[derive(Debug)]
pub(super) enum BridgeLineRead {
    Line(String),
    TooLong,
    Eof,
}

#[derive(Debug)]
pub(super) enum BridgeEvent {
    Hello(Value),
    Question {
        request_id: String,
        payload: Value,
    },
    BgTaskExit {
        task: Value,
        hash: String,
    },
    SubagentCompletion {
        details: Value,
        hash: String,
        wake: bool,
    },
    AssistantText {
        text: String,
        hash: String,
    },
    EmptyAfterCompactDeferred,
    Ignored,
}

pub(super) async fn read_bridge_line<R>(reader: &mut R) -> Result<BridgeLineRead, std::io::Error>
where
    R: AsyncBufRead + Unpin,
{
    let mut out = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if out.is_empty() {
                return Ok(BridgeLineRead::Eof);
            }
            return Ok(BridgeLineRead::Line(decode_line(&out)));
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            let take = newline + 1;
            if out.len().saturating_add(take) > MAX_BRIDGE_LINE {
                reader.consume(take);
                return Ok(BridgeLineRead::TooLong);
            }
            out.extend_from_slice(&available[..take]);
            reader.consume(take);
            return Ok(BridgeLineRead::Line(decode_line(&out)));
        }
        if out.len().saturating_add(available.len()) > MAX_BRIDGE_LINE {
            let take = available.len();
            reader.consume(take);
            drain_until_newline(reader).await?;
            return Ok(BridgeLineRead::TooLong);
        }
        let take = available.len();
        out.extend_from_slice(available);
        reader.consume(take);
    }
}

pub(super) fn parse_line(line: &str, state: &mut PiStreamState, pane_id: &str) -> Option<Value> {
    if line.trim().is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(line) {
        Ok(value) => {
            state.last_parse_error = None;
            Some(value)
        }
        Err(error) => {
            warn_parse_transition(state, pane_id, format!("{:?}", error.classify()), line);
            None
        }
    }
}

pub(super) fn classify_bridge_event(value: &Value, state: &mut PiStreamState) -> BridgeEvent {
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
            BridgeEvent::EmptyAfterCompactDeferred
        }
        "question" if question_opened(value) => question_event(value),
        "message_end" => message_end_event(value, state),
        _ => BridgeEvent::Ignored,
    }
}

pub(super) fn sha12(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    format!("{:02x}", digest[0])
        + &digest[1..]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()[..10]
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
        return bg_task_exit_event(message, state);
    }
    if custom_type == SUBAGENT_COMPLETION_CUSTOM_TYPE
        || (custom_type == PI_AGENTS_TMUX_CUSTOM_TYPE
            && message
                .pointer("/details/eventType")
                .and_then(Value::as_str)
                == Some(SUBAGENT_COMPLETION_EVENT_TYPE))
    {
        return subagent_completion_event(message, state);
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

fn bg_task_exit_event(message: &Value, state: &mut PiStreamState) -> BridgeEvent {
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
    BridgeEvent::BgTaskExit { task, hash }
}

fn subagent_completion_event(message: &Value, state: &mut PiStreamState) -> BridgeEvent {
    let details = message.get("details").cloned().unwrap_or_else(|| json!({}));
    let details_text = serde_json::to_string(&details).unwrap_or_else(|_| "{}".to_owned());
    let hash = sha12(&details_text);
    if !state.set_last_hash(hash.clone()) {
        return BridgeEvent::Ignored;
    }
    let wake = details
        .get("completions")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item.get("status")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    "blocked" | "failed" | "needs-completion" | "needs_completion"
                )
            })
        });
    BridgeEvent::SubagentCompletion {
        details,
        hash,
        wake,
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

fn decode_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches(['\r', '\n'])
        .to_owned()
}

async fn drain_until_newline<R>(reader: &mut R) -> Result<(), std::io::Error>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(());
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            reader.consume(newline + 1);
            return Ok(());
        }
        let take = available.len();
        reader.consume(take);
    }
}

fn warn_parse_transition(state: &mut PiStreamState, pane_id: &str, kind: String, line: &str) {
    if state.last_parse_error.as_deref() == Some(kind.as_str()) {
        return;
    }
    state.last_parse_error = Some(kind.clone());
    let excerpt = line.chars().take(160).collect::<String>();
    tracing::warn!(pane_id = %pane_id, error_kind = %kind, excerpt = %excerpt, "malformed pi-bridge stream line");
}
