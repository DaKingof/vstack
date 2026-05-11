#!/usr/bin/env bash
# Path resolvers + port allocator for the claude code Channels adapter.
#
# Sourced by open-terminal (channel spawn), pane-registry (auto-load
# channel metadata at init), pane-respond + pane-poll (read channel
# bridge metadata), flightdeck-daemon (per-pane JSONL tail subscriber).
#
# All file paths live under fd_resolve_state_dir (host-user-scoped).
# The channel-port allocator file is intentionally NOT session-keyed:
# concurrent flightdeck sessions on the same host must not collide on
# the 8780-8879 range.

# shellcheck source=daemon-paths.sh
source "$(dirname "${BASH_SOURCE[0]}")/daemon-paths.sh"

CC_PORT_RANGE_START=8780
CC_PORT_RANGE_END=8879

cc_ports_file()    { echo "$(fd_resolve_state_dir)/cc-channel-ports.json"; }
cc_ports_lock()    { echo "$(fd_resolve_state_dir)/cc-channel-ports.lock"; }
cc_spawn_file()    { echo "$(fd_resolve_state_dir)/cc-spawn-$1.json"; }
cc_mcp_dir()       { echo "$(fd_resolve_state_dir)/cc-channel/$1"; }
cc_mcp_config()    { echo "$(cc_mcp_dir "$1")/.mcp.json"; }

# Filename-safe form of a tmux pane_id ("%47" → "47").
cc_pane_id_safe() {
  local id="$1"
  echo "${id#%}"
}

# Session-keyed subscriber PID file. Caller MUST pass session_key as $2.
# See oc_subscriber_pid_file for the rationale (cross-session glob race).
cc_subscriber_pid_file() { echo "$(fd_resolve_state_dir)/fd-cc-subscriber-${2:?session_key required}-$(cc_pane_id_safe "$1").pid"; }

# Freshness probe for the claude-channel adapter (cross-harness review
# finding #2). The cc spawn file doesn't carry a server pid, so we check
# the two artifacts the subscriber needs: a reachable HTTP port and an
# existing transcript file. /dev/tcp is bash-native (no nc dependency)
# and short-timed via SECONDS guard.
cc_adapter_is_fresh() {
  local issue="$1"
  [[ -z "$issue" ]] && return 1
  local spawn_file port transcript
  spawn_file=$(cc_spawn_file "$issue")
  [[ -f "$spawn_file" ]] || return 1
  port=$(jq -r '.port // empty' "$spawn_file" 2>/dev/null)
  transcript=$(jq -r '.transcript // empty' "$spawn_file" 2>/dev/null)
  [[ -n "$transcript" && -f "$transcript" ]] || return 1
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 1
  # Bash /dev/tcp probe with a hard cap. Errors (port closed, ECONNREFUSED)
  # produce a non-zero exit immediately.
  ( exec 3<>"/dev/tcp/127.0.0.1/$port" ) 2>/dev/null || return 1
  exec 3>&- 3<&-
  return 0
}

# Probe a TCP port on 127.0.0.1 — returns 0 if free, 1 if in use.
cc_port_is_free() {
  local port="$1"
  if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 1
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port" && return 1
  fi
  return 0
}

# Allocate a free port in the channels range, atomically registering it
# in the host-global ports file under flock.
#
# Args: <issue-id>
# Stdout: the allocated port number.
# Exit: 0 success, 1 range exhausted.
cc_alloc_port() {
  local issue="$1"
  local ports_file lock_file
  ports_file=$(cc_ports_file)
  lock_file=$(cc_ports_lock)
  [[ -f "$ports_file" ]] || echo '{}' > "$ports_file"

  exec 214>"$lock_file"
  flock 214

  local now port tmp
  now=$(date -Iseconds)

  # Sweep: drop entries whose pid is dead (best-effort).
  if jq -e 'type == "object"' "$ports_file" >/dev/null 2>&1; then
    local live_tmp; live_tmp="${ports_file}.live.$$"
    echo '{}' > "$live_tmp"
    while IFS=$'\t' read -r p pid; do
      [[ -z "$p" ]] && continue
      if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
        jq --arg p "$p" --slurpfile orig "$ports_file" \
          '. + {($p): $orig[0][$p]}' "$live_tmp" > "${live_tmp}.2" \
          && mv "${live_tmp}.2" "$live_tmp"
      fi
    done < <(jq -r 'to_entries[] | "\(.key)\t\(.value.pid // 0)"' "$ports_file" 2>/dev/null)
    mv "$live_tmp" "$ports_file"
  else
    echo '{}' > "$ports_file"
  fi

  for (( port = CC_PORT_RANGE_START; port <= CC_PORT_RANGE_END; port++ )); do
    if jq -e --arg p "$port" 'has($p)' "$ports_file" >/dev/null 2>&1; then
      continue
    fi
    if ! cc_port_is_free "$port"; then
      continue
    fi
    tmp="${ports_file}.tmp.$$"
    jq --arg p "$port" --arg issue "$issue" --argjson pid $$ --arg ts "$now" \
      '. + {($p): {issue:$issue, pid:$pid, allocated_at:$ts}}' \
      "$ports_file" > "$tmp" && mv "$tmp" "$ports_file"
    exec 214>&-
    echo "$port"
    return 0
  done

  exec 214>&-
  return 1
}

cc_release_port() {
  local port="$1"
  local ports_file lock_file
  ports_file=$(cc_ports_file)
  lock_file=$(cc_ports_lock)
  [[ -f "$ports_file" ]] || return 0

  exec 215>"$lock_file"
  flock 215
  local tmp; tmp="${ports_file}.tmp.$$"
  jq --arg p "$port" 'del(.[$p])' "$ports_file" > "$tmp" 2>/dev/null \
    && mv "$tmp" "$ports_file"
  exec 215>&-
}

cc_register_port_pid() {
  local port="$1" pid="$2"
  local ports_file lock_file
  ports_file=$(cc_ports_file)
  lock_file=$(cc_ports_lock)
  [[ -f "$ports_file" ]] || echo '{}' > "$ports_file"

  exec 216>"$lock_file"
  flock 216
  local tmp; tmp="${ports_file}.tmp.$$"
  if jq --arg p "$port" --argjson pid "$pid" \
       '(.[$p] // {}) as $cur | .[$p] = ($cur + {pid: $pid})' \
       "$ports_file" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$ports_file"
  else
    rm -f "$tmp"
  fi
  exec 216>&-
}

# Encode an absolute cwd to claude's transcript filename convention:
# every `/` becomes `-`. e.g. `/home/method/dev/foo` → `-home-method-dev-foo`.
cc_encode_cwd() {
  local cwd="$1"
  echo "${cwd//\//-}"
}

# Derive a deterministic UUID from an issue id. md5sum reduced to UUID
# format: 8-4-4-4-12 hex digits. Pinning the session uuid makes the
# JSONL transcript path deterministic from the issue id.
cc_uuid_for_issue() {
  local issue="$1"
  local h
  h=$(printf '%s' "$issue" | md5sum | awk '{print $1}')
  printf '%s-%s-%s-%s-%s\n' \
    "${h:0:8}" "${h:8:4}" "${h:12:4}" "${h:16:4}" "${h:20:12}"
}

# Path to the JSONL transcript for a given (worktree, session-uuid).
cc_transcript_path() {
  local wt_path="$1" uuid="$2"
  local enc; enc=$(cc_encode_cwd "$(cd "$wt_path" && pwd)")
  echo "$HOME/.claude/projects/${enc}/${uuid}.jsonl"
}

# Path resolvers for cc-attach metadata.
# Channel server pid is recorded in the spawn file, NOT the registry —
# server pid is set after spawn and read on cleanup.

# Subscriber-emitted wake-events log path. Same file as opencode (one
# log per session, all subscribers append). Sourced from oc-paths is
# duplicated here as a comment-only reminder; the actual file path
# function lives in oc-paths.sh as oc_wake_events_log. We reuse it.
