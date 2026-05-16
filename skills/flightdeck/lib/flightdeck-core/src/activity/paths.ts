import { basename, dirname, join } from "node:path";

const STATE_PREFIX = "flightdeck-state-";
const ACTIVITY_PREFIX = "flightdeck-activity-";

export function activityPathForSession(session: string, stateBase: string): string {
	return join(stateBase, `${ACTIVITY_PREFIX}${session}.jsonl`);
}

export function activityPathFromStatePath(stateFile: string): string {
	const base = basename(stateFile);
	if (base.startsWith(STATE_PREFIX) && base.endsWith(".json")) {
		const session = base.slice(STATE_PREFIX.length, -".json".length);
		return join(dirname(stateFile), `${ACTIVITY_PREFIX}${session}.jsonl`);
	}
	return `${stateFile}.activity.jsonl`;
}

export function activityArchivePathFromStatePath(stateFile: string, terminatedAt: string): string {
	const activity = activityPathFromStatePath(stateFile);
	return activity.replace(/\.jsonl$/, `-${safeArchiveTimestamp(terminatedAt)}.jsonl.archive`);
}

export function safeArchiveTimestamp(ts: string): string {
	return ts.replace(/:/g, "");
}
