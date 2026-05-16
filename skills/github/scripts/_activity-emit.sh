#!/bin/bash
# Best-effort Flightdeck activity emitter for GitHub wrappers.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../flightdeck/scripts/_activity-emit.sh"

flightdeck_activity_emit github "$@" || true
exit 0
