// Pi subscriber → adhoc terminal-state-reached wake decision (vstack#61).
//
// This module is intentionally NOT wired into the TS daemon loop; the
// runtime emit path lives in `scripts/lib/subscribers.bash`
// `pi_subscriber_loop`, which mirrors this function 1:1. The TS export
// exists only as the canonical reference + unit-test surface.
//
// The bash Pi subscriber in scripts/lib/subscribers.bash sees assistant
// message_end events with stopReason set. For ADHOC Pi entries we treat
// those as `isIdle: false -> true` transitions and emit a wake-event
// row carrying classifier_tag=terminal-state-reached so the daemon's
// existing canonical-tag path delivers a wake to master.
//
// This module owns the pure decision so:
//   - The bash mirror has a clear canonical reference to stay in lock
//     step with (the CLAUDE.md parity rule).
//   - We can unit-test the row shape and gating exhaustively without
//     spawning bash + pi-bridge.

import { createHash } from "node:crypto";
import { classifyPiBridgeState, type PiBridgeStateLike } from "../classifier/pi-bridge-state.ts";

export interface PiAdhocWakeRow {
	ts: string;
	pane_id: string;
	harness: "pi";
	last_assistant_text: string;
	classifier_tag: "terminal-state-reached";
	hash: string;
}

export interface PiAdhocWakeDecision {
	emit: false;
	reason: string;
}

export interface PiAdhocWakeOk {
	emit: true;
	row: PiAdhocWakeRow;
}

export type PiAdhocWakeOutcome = PiAdhocWakeDecision | PiAdhocWakeOk;

export interface PiAdhocWakeInput {
	paneId: string;
	entryKind: string;
	entryHarness: string;
	bridgeState: PiBridgeStateLike | null | undefined;
	now?: () => Date;
}

function shortHash(parts: readonly string[]): string {
	return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);
}

export function decidePiAdhocWake(input: PiAdhocWakeInput): PiAdhocWakeOutcome {
	if (!input.paneId) return { emit: false, reason: "missing-pane-id" };
	const classification = classifyPiBridgeState(input.bridgeState, {
		entryKind: input.entryKind,
		entryHarness: input.entryHarness,
	});
	if (classification.tag !== "terminal-state-reached") {
		return { emit: false, reason: classification.matched || classification.tag };
	}
	const ts = (input.now?.() ?? new Date()).toISOString();
	const hash = shortHash([input.paneId, "adhoc-pi-idle", ts.slice(0, 19)]);
	return {
		emit: true,
		row: {
			ts,
			pane_id: input.paneId,
			harness: "pi",
			last_assistant_text: "",
			classifier_tag: "terminal-state-reached",
			hash,
		},
	};
}
