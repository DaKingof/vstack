// Pi bridge-state classifier for tracked-entry lifecycle.
//
// The buffer-text classifier in classify.ts works on tmux capture output
// (a string). Pi panes expose a richer signal through pi-bridge: the
// session's `isIdle` flag and `hasPendingMessages` indicator. For ADHOC
// Pi entries — where master has no issue-mode prompt tags to read —
// reaching `isIdle: true && hasPendingMessages: false` is the canonical
// "done" state, and session-watch advances waiting → complete on it.
//
// Issue-mode and other-harness entries keep their existing classifier
// path (buffer text + post-footer rules), so the gating below MUST
// require both kind == "adhoc" AND harness == "pi".

export interface PiBridgeStateLike {
	isIdle?: unknown;
	hasPendingMessages?: unknown;
	[key: string]: unknown;
}

export type PiBridgeStateTag = "terminal-state-reached" | "idle" | "rendering";

export interface PiBridgeStateClassification {
	tag: PiBridgeStateTag;
	matched: string;
}

export interface PiBridgeStateOptions {
	entryKind: string;
	entryHarness: string;
}

function normalizeKind(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

export function classifyPiBridgeState(
	state: PiBridgeStateLike | null | undefined,
	options: PiBridgeStateOptions,
): PiBridgeStateClassification {
	const kind = normalizeKind(options.entryKind);
	const harness = normalizeKind(options.entryHarness);
	if (!state || typeof state !== "object" || Array.isArray(state)) {
		return { tag: "rendering", matched: "no-bridge-state" };
	}
	const isIdle = state.isIdle === true;
	const hasPendingMessages = state.hasPendingMessages === true;
	if (!isIdle) return { tag: "rendering", matched: "bridge-state busy" };
	if (hasPendingMessages) return { tag: "idle", matched: "bridge-state idle with pending messages" };
	if (kind === "adhoc" && harness === "pi") {
		return { tag: "terminal-state-reached", matched: "adhoc pi idle, no pending messages" };
	}
	return { tag: "idle", matched: `bridge-state idle (kind=${kind || "unknown"} harness=${harness || "unknown"})` };
}
