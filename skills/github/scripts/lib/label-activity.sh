#!/usr/bin/env bash
# Shared activity emit helper for label-add / label-remove wrappers.
# Sourced by skills/github/scripts/commands/label-{add,remove}.sh.

# emit_label_activity <add|remove> <pr|issue> <ref> <label> <reason>
# Best-effort: returns 0 unconditionally so emit failures never block
# the underlying gh command's success.
emit_label_activity() {
    local action="$1" kind="$2" ref="$3" label="$4" reason="$5"
    if [ "${FLIGHTDECK_MANAGED:-}" != "1" ] && [ -z "${FLIGHTDECK_ACTIVITY_FILE:-}" ]; then
        return 0
    fi

    local verb type preposition
    if [ "$action" = "remove" ]; then
        verb="Removed"
        type="${kind}.unlabeled"
        preposition="from"
    else
        verb="Added"
        type="${kind}.labeled"
        preposition="to"
    fi

    local target
    if [ "$kind" = "issue" ]; then
        target="issue $ref"
    else
        target="PR #$ref"
    fi

    local summary
    if [ -n "$reason" ]; then
        summary="$verb $label $preposition $target: $reason"
    else
        summary="$verb $label $preposition $target"
    fi

    local details
    details=$(jq -cn --arg label "$label" --arg reason "$reason" \
        '{label: $label} + (if $reason != "" then {reason: $reason} else {} end)') || return 0

    local emit_args=(--severity info --importance normal --summary "$summary" --details-json "$details")
    if [ "$kind" = "issue" ]; then
        emit_args+=(--issue-id "$ref")
    else
        emit_args+=(--pr-number "$ref")
    fi
    if [ -n "${FLIGHTDECK_ENTRY_ID:-}" ]; then
        emit_args+=(--entry-id "$FLIGHTDECK_ENTRY_ID")
    fi

    local lib_dir
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    bash "$lib_dir/../_activity-emit.sh" "$type" "${emit_args[@]}" || true
    return 0
}
