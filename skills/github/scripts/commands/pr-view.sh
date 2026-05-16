#!/bin/bash
# View PR details for current branch or specified PR
# Usage: pr-view [PR_NUMBER] [--json FIELDS]

set -euo pipefail

show_help() {
    cat << 'EOF'
View PR details

Usage: pr-view [PR_NUMBER] [options]

Arguments:
  PR_NUMBER    PR number (optional, defaults to current branch's PR)

Options:
  --json FIELDS    Output specific fields as JSON (e.g., --json number,title)
  --help           Show this help

Examples:
  github.sh pr-view              # View PR for current branch
  github.sh pr-view 68           # View PR #68
  github.sh pr-view --json number   # Check if PR exists (returns JSON or fails)
  github.sh -C /path/to/worktree pr-view --json number
EOF
}

main() {
    local pr_num=""
    local json_fields=""
    local -a extra_args=()

    while [ $# -gt 0 ]; do
        case "$1" in
            --json)
                json_fields="$2"
                shift 2
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            -*)
                extra_args+=("$1")
                shift
                ;;
            *)
                if [ -z "$pr_num" ]; then
                    pr_num="$1"
                else
                    extra_args+=("$1")
                fi
                shift
                ;;
        esac
    done

    local -a cmd=(gh pr view)
    [ -n "$pr_num" ] && cmd+=("$pr_num")
    [ -n "$json_fields" ] && cmd+=(--json "$json_fields")
    [ ${#extra_args[@]} -gt 0 ] && cmd+=("${extra_args[@]}")

    local output status=0
    output=$("${cmd[@]}") || status=$?
    if [ -n "$output" ]; then
        printf '%s\n' "$output"
    fi
    if [ "$status" -ne 0 ]; then
        exit "$status"
    fi
    emit_checks_activity "$json_fields" "$pr_num" "$output"
}

emit_checks_activity() {
    local json_fields="$1"
    local pr_ref="$2"
    local output="$3"
    if [ "${FLIGHTDECK_MANAGED:-}" != "1" ] && [ -z "${FLIGHTDECK_ACTIVITY_FILE:-}" ]; then
        return 0
    fi
    if [[ ",$json_fields," != *",statusCheckRollup,"* ]]; then
        return 0
    fi
    if ! command -v jq >/dev/null 2>&1; then
        return 0
    fi
    local outcome
    outcome=$(echo "$output" | jq -r '
        (.statusCheckRollup // []) as $checks |
        if ($checks | length) == 0 then ""
        elif all($checks[]; ((.conclusion // .state // .status // "") | ascii_upcase) as $s | ($s == "SUCCESS" or $s == "SKIPPED" or $s == "COMPLETED")) then "passed"
        elif any($checks[]; ((.conclusion // .state // .status // "") | ascii_upcase) as $s | ($s == "FAILURE" or $s == "FAILED" or $s == "ERROR" or $s == "CANCELLED" or $s == "TIMED_OUT" or $s == "ACTION_REQUIRED")) then "failed"
        else "" end
    ' 2>/dev/null || true)
    if [ -z "$outcome" ]; then
        return 0
    fi
    local pr_number
    pr_number=$(echo "$output" | jq -r '.number // empty' 2>/dev/null || true)
    if [ -z "$pr_number" ] && [[ "$pr_ref" =~ ^[0-9]+$ ]]; then
        pr_number="$pr_ref"
    fi
    local type severity summary
    if [ "$outcome" = "passed" ]; then
        type="pr.checks_passed"
        severity="success"
        summary="PR checks passed"
    else
        type="pr.checks_failed"
        severity="warning"
        summary="PR checks failed"
    fi
    [ -n "$pr_number" ] && summary="$summary for #$pr_number"
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../_activity-emit.sh" "$type" \
        --severity "$severity" \
        --importance normal \
        --summary "$summary" \
        --pr-number "$pr_number" || true
}

main "$@"
