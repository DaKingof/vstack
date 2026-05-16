// Daemon wake noise reduction (vstack#68, #69).
//
// Two filters live here so the loop can ask one set of pure helpers
// whether a candidate wake should fire:
//
//   1. shouldEmitBellWake — Fix #68. Bell wakes from rendering/idle tags
//      are dropped entirely (a plain BEL with no prompt is just terminal
//      noise). Bell wakes for canonical tags are rate-limited per pane:
//      successive bell wakes within FD_BELL_WAKE_INTERVAL_SEC (default
//      60s) are suppressed. Real attention-worthy events (questions,
//      confirms, merge-now, etc.) still wake on the first observation.
//
//   2. shouldEmitBgTaskExitWake — Fix #69. pi-background-tasks already
//      drops `notifyOnExit: false` wakes at the source, but the daemon
//      enforces it defensively for tasks restored from older snapshots
//      or sent by other producers. Also suppresses wakes for tasks that
//      opted into notifyMode=first-match-only and exited cleanly
//      (status=completed && exitCode=0): the first-match-only contract
//      is "wake once for the matching output, not on every event"; a
//      clean exit with no new output is not a new match.

export const BELL_WAKE_INTERVAL_DEFAULT_SEC = 60;
export const BELL_NON_CANONICAL_DROP_REASON = "bell-non-canonical";
export const BELL_RATE_LIMIT_DROP_REASON = "bell-rate-limited";

export interface BellWakeOptions {
	paneId: string;
	tag: string;
	isCanonical: boolean;
	intervalSec?: number;
	nowSec: number;
}

export type BellWakeDecision =
	| { emit: true }
	| { emit: false; reason: string; suppressedUntil?: number };

export interface BellWakeState {
	/** Map of paneId -> epoch seconds of most recent bell wake. */
	lastBellWakeAt: Map<string, number>;
}

export function makeBellWakeState(): BellWakeState {
	return { lastBellWakeAt: new Map() };
}

// Rate-limit is keyed per-pane, not per-tag. Two distinct canonical bell-tagged
// events on the same pane inside FD_BELL_WAKE_INTERVAL_SEC collapse to one wake.
// The stable-age classifier still picks up new state on the next tick within
// `stab` seconds, so events are delayed rather than lost. If per-tag granularity
// becomes important, key lastBellWakeAt by `${paneId}:${tag}` instead.
export function shouldEmitBellWake(state: BellWakeState, opts: BellWakeOptions): BellWakeDecision {
	if (!opts.isCanonical) {
		return { emit: false, reason: BELL_NON_CANONICAL_DROP_REASON };
	}
	const interval = Math.max(0, Math.floor(opts.intervalSec ?? BELL_WAKE_INTERVAL_DEFAULT_SEC));
	if (interval > 0) {
		const last = state.lastBellWakeAt.get(opts.paneId);
		if (last !== undefined && opts.nowSec - last < interval) {
			return {
				emit: false,
				reason: BELL_RATE_LIMIT_DROP_REASON,
				suppressedUntil: last + interval,
			};
		}
	}
	return { emit: true };
}

export function recordBellWake(state: BellWakeState, paneId: string, nowSec: number): void {
	state.lastBellWakeAt.set(paneId, nowSec);
}

export function bellWakeIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.FD_BELL_WAKE_INTERVAL_SEC?.trim();
	if (!raw) return BELL_WAKE_INTERVAL_DEFAULT_SEC;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return BELL_WAKE_INTERVAL_DEFAULT_SEC;
	return Math.floor(parsed);
}

export interface BgTaskExitWakeInput {
	task?: {
		notifyOnExit?: unknown;
		notifyMode?: unknown;
		status?: unknown;
		exitCode?: unknown;
		[key: string]: unknown;
	} | null | undefined;
}

export type BgTaskExitWakeDecision =
	| { emit: true }
	| { emit: false; reason: string };

export function shouldEmitBgTaskExitWake(input: BgTaskExitWakeInput): BgTaskExitWakeDecision {
	const task = input.task;
	if (task && typeof task === "object") {
		if (task.notifyOnExit === false) {
			return { emit: false, reason: "notify-exit-disabled" };
		}
		const mode = typeof task.notifyMode === "string" ? task.notifyMode : undefined;
		const status = typeof task.status === "string" ? task.status : undefined;
		const exitCode = typeof task.exitCode === "number" ? task.exitCode : null;
		if (mode === "first-match-only" && status === "completed" && exitCode === 0) {
			return { emit: false, reason: "first-match-only-clean-exit" };
		}
	}
	return { emit: true };
}
