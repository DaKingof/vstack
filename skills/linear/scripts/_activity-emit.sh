#!/bin/bash
# Best-effort Flightdeck activity emitter for Linear wrappers.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../../flightdeck/scripts/_activity-emit.sh"

flightdeck_activity_emit linear "$@" || true
exit 0
