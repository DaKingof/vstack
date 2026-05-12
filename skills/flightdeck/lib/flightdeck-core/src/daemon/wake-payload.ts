// Port of scripts/flightdeck-daemon.bash::wake_payload_for_harness.
//
// Build the wake message payload for a given master harness. Each TUI
// parses commands with its own grammar prefix; sending the slash form
// to codex (which uses `$` for commands) or to a Pi session via the
// bridge (slash/skill expansion is bypassed) means the master LLM only
// sees raw text it has to interpret rather than a real command
// invocation. Default keeps the legacy slash form for unspecified
// harnesses so existing claude/opencode behavior is unchanged.
//
// Pi-specific routing (vstack#13): pi-session-bridge expands
// /skill:<name> client-side before sendUserMessage, so the daemon can
// use the canonical flightdeck skill command again. If the bridge is
// unavailable, wake.ts falls back to tmux send-keys -l + Enter for Pi
// instead of paste-buffer.

export function wakePayloadForHarness(harness: string | undefined | null): string {
	switch ((harness ?? "").toLowerCase()) {
		case "codex":
			return "$flightdeck watch --from-daemon";
		case "pi":
			return "/skill:flightdeck watch --from-daemon";
		default:
			return "/flightdeck watch --from-daemon";
	}
}
