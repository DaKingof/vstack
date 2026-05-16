#!/usr/bin/env bash
# vstack#15: emit canonical pi-bg-task-exit wake events.
#
# Sourced by the Pi subscriber body in subscribers.bash. When the
# subscriber sees a vstack-background-tasks:event message_end with
# details.eventType="exit" it calls emit_pi_bg_task_exit_event from
# this file.
#
# Required env (set by the subscriber):
#   SESSION_LOCK     — flock target for the wake-events log
#   WAKE_EVENTS_LOG  — append target for canonical wake rows

# Canonical contract constants. Kept in sync with the TS port via
# lib/flightdeck-core/src/events/bg-task-exit.ts; the contract test in
# tests/unit/bg-task-exit-contract.test.ts asserts both match.
export BG_TASK_EVENT_CUSTOM_TYPE="vstack-background-tasks:event"
export BG_TASK_EXIT_EVENT_TYPE="exit"
export BG_TASK_EXIT_CLASSIFIER_TAG="pi-bg-task-exit"
export BG_TASK_ACTIVITY_CLASSIFIER_TAG="pi-bg-task-activity"

# jq select expression matching a `pi-bridge stream` event line for a
# vstack-background-tasks exit message. Echoed so callers can splice it
# into their broader filter.
bg_task_exit_jq_select() {
  cat <<'JQ'
(.type == "event" and .event == "message_end" and ((.data.message.customType // "") == "vstack-background-tasks:event") and ((.data.message.details.eventType // "") == "exit"))
JQ
}

# Emit a pi-bg-task-exit wake event for a JSONL line that already passed
# the message_end + customType + eventType=exit jq filter. Dedupes
# against a caller-supplied last_hash variable name (bash nameref) so
# repeated reads of the same JSONL row do not fire twice.
#
# Args:
#   $1: pane_id (e.g. "%18")
#   $2: jsonl line
#   $3: name of last_hash variable in caller's scope (passed by name)
#   $4: optional sub_log path for human-readable trace lines
#
# Returns:
#   0 — wake row appended
#   1 — duplicate (hash matches last_hash); caller should `continue`
#   2 — malformed input (bg_details missing/null)
emit_pi_bg_task_exit_event() {
  local pane_id="$1" line="$2" last_hash_var="$3" sub_log="${4:-/dev/null}"
  local bg_details bg_task_id bg_status bg_exit_code bg_sequence bg_hash
  bg_details=$(jq -c '.data.message.details // {}' <<< "$line" 2>/dev/null)
  if [[ -z "$bg_details" || "$bg_details" == "null" ]]; then
    bg_details="{}"
  fi
  bg_task_id=$(jq -r '.task.id // ""' <<< "$bg_details" 2>/dev/null)
  bg_status=$(jq -r '.task.status // ""' <<< "$bg_details" 2>/dev/null)
  bg_exit_code=$(jq -r '.task.exitCode // "null"' <<< "$bg_details" 2>/dev/null)
  bg_sequence=$(jq -c '.sequence // null' <<< "$bg_details" 2>/dev/null)
  [[ -z "$bg_sequence" ]] && bg_sequence="null"
  bg_hash=$(printf '%s|%s|%s|%s' "$bg_task_id" "$bg_status" "$bg_exit_code" "$bg_sequence" | sha256sum | awk '{print substr($1,1,12)}')

  if [[ -n "$last_hash_var" ]]; then
    # bash 4.3+ nameref; flightdeck-daemon already requires bash 4.x
    # everywhere it runs.
    local -n _bg_last_hash_ref="$last_hash_var"
    if [[ "$bg_hash" == "$_bg_last_hash_ref" ]]; then
      return 1
    fi
  fi

  printf '%s [pi-bg-task-exit] pane=%s task=%s status=%s exit=%s\n' \
    "$(date -Iseconds)" "$pane_id" "$bg_task_id" "$bg_status" "$bg_exit_code" \
    >> "$sub_log" 2>/dev/null || true
  ( exec 218>"$SESSION_LOCK"
    flock 218
    jq -nc --arg ts "$(date -Iseconds)" \
           --arg pid "$pane_id" \
           --arg harness "pi" \
           --arg tag "$BG_TASK_EXIT_CLASSIFIER_TAG" \
           --arg h "$bg_hash" \
           --argjson sequence "$bg_sequence" \
           --argjson details "$bg_details" \
           '{ts:$ts, pane_id:$pid, harness:$harness, event_type:"bg-task-exit", sequence:$sequence, task:(($details).task // {}), classifier_tag:$tag, hash:$h}' \
           >> "$WAKE_EVENTS_LOG"
  )

  if [[ -n "$last_hash_var" ]]; then
    local -n _bg_last_hash_ref2="$last_hash_var"
    _bg_last_hash_ref2="$bg_hash"
  fi
  return 0
}

# Emit an activity-only bg-task row for non-terminal background task
# signals. The TS daemon drains this row and records JSONL activity but
# does not treat BG_TASK_ACTIVITY_CLASSIFIER_TAG as canonical, so wake
# routing stays unchanged.
emit_pi_bg_task_activity_event() {
  local pane_id="$1" line="$2" last_hash_var="$3" sub_log="${4:-/dev/null}"
  local bg_details bg_task_id bg_event_type bg_sequence bg_hash
  bg_details=$(jq -c '.data.message.details // {}' <<< "$line" 2>/dev/null)
  if [[ -z "$bg_details" || "$bg_details" == "null" ]]; then
    bg_details="{}"
  fi
  bg_task_id=$(jq -r '.task.id // ""' <<< "$bg_details" 2>/dev/null)
  bg_event_type=$(jq -r '.eventType // .event_type // "activity"' <<< "$bg_details" 2>/dev/null)
  bg_sequence=$(jq -r '.sequence // .task.sequence // .task.updatedAt // "0"' <<< "$bg_details" 2>/dev/null)
  bg_hash=$(printf '%s|%s|%s' "$bg_task_id" "$bg_event_type" "$bg_sequence" | sha256sum | awk '{print substr($1,1,12)}')

  if [[ -n "$last_hash_var" ]]; then
    local -n _bg_last_hash_ref="$last_hash_var"
    if [[ "$bg_hash" == "$_bg_last_hash_ref" ]]; then
      return 1
    fi
  fi

  printf '%s [pi-bg-task-activity] pane=%s task=%s event=%s sequence=%s\n' \
    "$(date -Iseconds)" "$pane_id" "$bg_task_id" "$bg_event_type" "$bg_sequence" \
    >> "$sub_log" 2>/dev/null || true
  ( exec 218>"$SESSION_LOCK"
    flock 218
    jq -nc --arg ts "$(date -Iseconds)" \
           --arg pid "$pane_id" \
           --arg harness "pi" \
           --arg tag "$BG_TASK_ACTIVITY_CLASSIFIER_TAG" \
           --arg h "$bg_hash" \
           --arg event_type "$bg_event_type" \
           --arg sequence "$bg_sequence" \
           --argjson details "$bg_details" \
           '{ts:$ts, pane_id:$pid, harness:$harness, event_type:"bg-task-activity", activity_event_type:$event_type, sequence:$sequence, task:(($details).task // {}), classifier_tag:$tag, hash:$h}' \
           >> "$WAKE_EVENTS_LOG"
  )

  if [[ -n "$last_hash_var" ]]; then
    local -n _bg_last_hash_ref2="$last_hash_var"
    _bg_last_hash_ref2="$bg_hash"
  fi
  return 0
}
