use serde_json::Value;

use crate::daemon::wake::{apply_domain_guard, is_canonical_tag, WakeEvent};

use super::classifier;
use super::stream_parse::{self, BridgeEvent};
use super::{PiConfig, PiStreamState};

const TEXT_EXCERPT_BYTES: usize = 1024;

pub(super) async fn handle_line(config: &PiConfig, state: &mut PiStreamState, line: &str) {
    let Some(value) = stream_parse::parse_line(line, state, &config.pane_id) else {
        return;
    };
    match stream_parse::classify_bridge_event(&value, state) {
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
        BridgeEvent::SubagentCompletion {
            details,
            hash,
            wake,
        } => {
            if wake {
                emit_wake(
                    config,
                    WakeEvent::subagent_completion(config.pane_id.clone(), details, hash),
                )
                .await;
            } else {
                tracing::info!(pane_id = %config.pane_id, "pi subagent completion succeeded without wake");
            }
        }
        BridgeEvent::AssistantText { text, hash } => {
            let raw_tag = classifier::classify_text(config, state, &text).await;
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
        let hash = stream_parse::sha12(request_id);
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
    let hash = stream_parse::sha12(&request_id);
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
