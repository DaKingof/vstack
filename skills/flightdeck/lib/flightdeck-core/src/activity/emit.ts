import { appendActivityEvent, tryAppendActivityEvent } from "./append.ts";
import { resolveActivityPath } from "./paths.ts";
import type { ActivityEventInput } from "./types.ts";

export interface EmitContext {
	stateFile: string;
	sessionId?: string;
	tmuxSession?: string;
	stateDir?: string;
}

export function emitActivity(ctx: EmitContext, ev: ActivityEventInput): void {
	emitActivityWithPath(resolveActivityPath(ctx), ev, { sessionId: ctx.sessionId ?? ctx.tmuxSession });
}

const warnedNonblockingFailures = new Set<string>();

export function emitActivityWithPath(file: string | null | undefined, ev: ActivityEventInput, opts: { nonblocking?: boolean; sessionId?: string } = {}): void {
	if (!file) return;
	if (opts.nonblocking) {
		const result = tryAppendActivityEvent(file, ev, { sessionId: opts.sessionId });
		if (!result.appended && result.reason && result.reason !== "duplicate" && result.reason !== "archived") {
			warnNonblockingFailure(file, ev, opts.sessionId, result.reason, result.error);
		}
		return;
	}
	try {
		appendActivityEvent(file, ev, { sessionId: opts.sessionId });
	} catch (err) {
		const type = typeof ev.type === "string" && ev.type ? ev.type : "unknown";
		const entry = typeof ev.entry_id === "string" && ev.entry_id ? ev.entry_id : opts.sessionId ?? "unknown";
		process.stderr.write(`flightdeck: activity emit failed [type=${type} entry=${entry} file=${file}]: ${err instanceof Error ? err.message : String(err)}\n`);
	}
}

function warnNonblockingFailure(file: string, ev: ActivityEventInput, sessionId: string | undefined, reason: string, error: string | undefined): void {
	const type = typeof ev.type === "string" && ev.type ? ev.type : "unknown";
	const entry = typeof ev.entry_id === "string" && ev.entry_id ? ev.entry_id : sessionId ?? "unknown";
	const key = `${file}\0${type}\0${reason}`;
	if (warnedNonblockingFailures.has(key)) return;
	warnedNonblockingFailures.add(key);
	process.stderr.write(`flightdeck: activity emit skipped [type=${type} entry=${entry} file=${file} reason=${reason}]: ${error ?? "nonblocking append failed"}\n`);
}
