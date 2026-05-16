import { appendActivityEvent } from "./append.ts";
import { resolveActivityPath } from "./paths.ts";
import type { ActivityEventInput } from "./types.ts";

export interface EmitContext {
	stateFile: string;
	sessionId?: string;
	tmuxSession?: string;
	stateDir?: string;
}

export function emitActivity(ctx: EmitContext, ev: ActivityEventInput): void {
	const file = resolveActivityPath(ctx);
	if (!file) return;
	try {
		appendActivityEvent(file, ev, { sessionId: ctx.sessionId ?? ctx.tmuxSession });
	} catch (err) {
		const type = typeof ev.type === "string" && ev.type ? ev.type : "unknown";
		const entry = typeof ev.entry_id === "string" && ev.entry_id ? ev.entry_id : ctx.sessionId ?? ctx.tmuxSession ?? "unknown";
		process.stderr.write(`flightdeck: activity emit failed [type=${type} entry=${entry} file=${file}]: ${err instanceof Error ? err.message : String(err)}\n`);
	}
}
