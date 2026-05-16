import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
	ActivityValidationError,
	DEFAULT_ACTIVITY_DETAILS_MAX_BYTES,
	DEFAULT_ACTIVITY_MAX_BYTES,
	DEFAULT_ACTIVITY_MAX_EVENTS,
	normalizeActivityEvent,
	type ActivityEventInput,
	type FlightdeckActivityEventV1,
	type NormalizeActivityOptions,
} from "./types.ts";

const RECENT_ID_CACHE_LIMIT = 512;
const recentIds = new Map<string, true>();

export interface AppendActivityOptions extends NormalizeActivityOptions {
	maxEvents?: number;
	maxBytes?: number;
}

export interface AppendActivityResult {
	event: FlightdeckActivityEventV1;
	appended: boolean;
}

export function appendActivityEvent(file: string, input: ActivityEventInput, opts: AppendActivityOptions = {}): AppendActivityResult {
	const event = normalizeActivityEvent(input, opts);
	const line = stringifyEventForAppend(event, opts.detailsMaxBytes ?? DEFAULT_ACTIVITY_DETAILS_MAX_BYTES);
	const maxBytes = opts.maxBytes ?? DEFAULT_ACTIVITY_MAX_BYTES;
	const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
	if (lineBytes > maxBytes) {
		throw new ActivityValidationError(`activity event exceeds session byte cap (${lineBytes} > ${maxBytes})`);
	}
	const recentKey = `${file}\0${event.id}`;
	if (recentIds.has(recentKey)) return { appended: false, event };
	const appended = lockedAppendJsonlDedup({
		file,
		id: event.id,
		line,
		maxBytes,
		maxEvents: opts.maxEvents ?? DEFAULT_ACTIVITY_MAX_EVENTS,
	});
	if (appended) rememberId(recentKey);
	return { appended, event };
}

function stringifyEventForAppend(event: FlightdeckActivityEventV1, detailsMaxBytes: number): string {
	let line = JSON.stringify(event);
	const maxEventBytes = detailsMaxBytes * 2;
	if (line.length <= maxEventBytes) return line;
	if (event.details) {
		const detailsBytes = Buffer.byteLength(JSON.stringify(event.details), "utf8");
		event.details = { original_bytes: detailsBytes, truncated: true };
		line = JSON.stringify(event);
	}
	if (line.length <= maxEventBytes) return line;
	if (event.body) {
		delete event.body;
		line = JSON.stringify(event);
	}
	if (line.length <= maxEventBytes) return line;
	throw new ActivityValidationError(`activity event exceeds maximum size (${line.length} > ${maxEventBytes})`);
}

function rememberId(key: string): void {
	recentIds.set(key, true);
	while (recentIds.size > RECENT_ID_CACHE_LIMIT) {
		const first = recentIds.keys().next().value;
		if (!first) break;
		recentIds.delete(first);
	}
}

interface LockedAppendOpts {
	file: string;
	id: string;
	line: string;
	maxEvents: number;
	maxBytes: number;
}

function lockedAppendJsonlDedup(opts: LockedAppendOpts): boolean {
	mkdirSync(dirname(opts.file), { recursive: true });
	const lockFile = `${opts.file}.lock`;
	const idNeedle = `"id":${JSON.stringify(opts.id)}`;
	const script = `
		set -euo pipefail
		file="$1"; needle="$2"; max_events="$3"; max_bytes="$4"
		mkdir -p "$(dirname "$file")"
		touch "$file"
		if grep -Fq -- "$needle" "$file"; then
			exit 10
		fi
		cat >> "$file"
		bytes=$(wc -c < "$file" | tr -d ' ')
		lines=$(wc -l < "$file" | tr -d ' ')
		if (( lines > max_events )); then
			tmp="$file.tmp.$$"
			tail -n "$max_events" "$file" > "$tmp"
			mv "$tmp" "$file"
		fi
		bytes=$(wc -c < "$file" | tr -d ' ')
		if (( bytes > max_bytes )); then
			tmp="$file.tmp.$$"
			LC_ALL=C awk -v max_bytes="$max_bytes" '
				{
					lines[NR] = $0
					sizes[NR] = length($0) + 1
				}
				END {
					bytes = 0
					start = NR + 1
					for (i = NR; i >= 1; i--) {
						if (bytes + sizes[i] > max_bytes) break
						bytes += sizes[i]
						start = i
					}
					for (i = start; i <= NR; i++) print lines[i]
				}
			' "$file" > "$tmp"
			mv "$tmp" "$file"
		fi
	`;
	const r = spawnSync("flock", [
		"-x", lockFile, "bash", "-c", script, "_",
		opts.file, idNeedle, String(opts.maxEvents), String(opts.maxBytes),
	], { encoding: "utf8", input: `${opts.line}\n` });
	if (r.status === 10) return false;
	if (r.status !== 0) {
		throw new Error(`activity append failed: ${r.stderr || `exit ${r.status ?? "unknown"}`}`);
	}
	return true;
}
