#!/bin/bash
# Best-effort Flightdeck activity emitter for GitHub wrappers.
# Silent unless Flightdeck manages the caller or an explicit activity file is set.

set -uo pipefail

main() {
    if [ "${FLIGHTDECK_MANAGED:-}" != "1" ] && [ -z "${FLIGHTDECK_ACTIVITY_FILE:-}" ]; then
        return 0
    fi

    local type="${1:-}"
    shift || true
    if [ -z "$type" ]; then
        return 0
    fi

    local source="github" severity="info" importance="normal" summary="$type"
    local entry_id="" pr_number="" issue_id="" linear_id="" commit="" check_name="" details_json="{}"

    while [ $# -gt 0 ]; do
        case "$1" in
            --source) source="${2:-}"; shift 2 ;;
            --severity) severity="${2:-}"; shift 2 ;;
            --importance) importance="${2:-}"; shift 2 ;;
            --summary) summary="${2:-}"; shift 2 ;;
            --entry-id) entry_id="${2:-}"; shift 2 ;;
            --pr-number) pr_number="${2:-}"; shift 2 ;;
            --issue-id) issue_id="${2:-}"; shift 2 ;;
            --linear-id) linear_id="${2:-}"; shift 2 ;;
            --commit) commit="${2:-}"; shift 2 ;;
            --check-name) check_name="${2:-}"; shift 2 ;;
            --details-json) details_json="${2:-{}}"; shift 2 ;;
            *) shift ;;
        esac
    done

    if ! command -v jq >/dev/null 2>&1; then
        return 0
    fi
    if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$details_json"; then
        details_json="{}"
    fi

    local script_dir fd_state
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return 0
    fd_state="${FLIGHTDECK_STATE_BIN:-}"
    if [ -z "$fd_state" ]; then
        if [ -x "$script_dir/../../flightdeck/scripts/flightdeck-state" ]; then
            fd_state="$script_dir/../../flightdeck/scripts/flightdeck-state"
        elif command -v flightdeck-state >/dev/null 2>&1; then
            fd_state="$(command -v flightdeck-state)"
        else
            return 0
        fi
    fi

    local payload
    payload=$(jq -cn \
        --arg source "$source" \
        --arg type "$type" \
        --arg severity "$severity" \
        --arg importance "$importance" \
        --arg summary "$summary" \
        --arg entry_id "$entry_id" \
        --arg pr_number "$pr_number" \
        --arg issue_id "$issue_id" \
        --arg linear_id "$linear_id" \
        --arg commit "$commit" \
        --arg check_name "$check_name" \
        --argjson details "$details_json" '
        {
            source: $source,
            type: $type,
            severity: $severity,
            importance: $importance,
            summary: $summary,
            details: ($details + {dedup_key: ([ $source, $type, $entry_id, $pr_number, $issue_id, $linear_id, $commit, $check_name, ($details | tostring) ] | join(":"))})
        }
        + (if $entry_id != "" then {entry_id: $entry_id} else {} end)
        + ({refs: (
            {}
            + (if ($pr_number | test("^[0-9]+$")) then {pr_number: ($pr_number | tonumber)} else {} end)
            + (if $issue_id != "" then {issue_id: $issue_id} else {} end)
            + (if $linear_id != "" then {linear_id: $linear_id} else {} end)
            + (if $commit != "" then {commit: $commit} else {} end)
            + (if $check_name != "" then {check_name: $check_name} else {} end)
        )} | if (.refs | length) == 0 then del(.refs) else . end)
    ') || return 0

    local session="${FLIGHTDECK_SESSION:-}"
    if [ -z "$session" ] && [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
        session="$(tmux display-message -p '#S' 2>/dev/null || true)"
    fi
    session="${session:-flightdeck}"
    "$fd_state" activity --session "$session" append "$payload" >/dev/null 2>&1 || true
    return 0
}

main "$@" || true
exit 0
