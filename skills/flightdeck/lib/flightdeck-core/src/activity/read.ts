import { existsSync, readFileSync } from "node:fs";

import {
	DEFAULT_ACTIVITY_LIMIT,
	normalizeActivityEvent,
	type ActivityEventInput,
	type FlightdeckActivityEventV1,
} from "./types.ts";

export interface ReadActivityOptions {
	limit?: number;
	filter?: string;
	warn?: (message: string) => void;
}

export function readActivityEvents(file: string, opts: ReadActivityOptions = {}): FlightdeckActivityEventV1[] {
	if (!existsSync(file)) return [];
	const warn = opts.warn ?? (() => undefined);
	const lines = readFileSync(file, "utf8").split("\n");
	const events: FlightdeckActivityEventV1[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]!.trim();
		if (!line) continue;
		let parsed: ActivityEventInput;
		try {
			parsed = JSON.parse(line) as ActivityEventInput;
		} catch (error) {
			warn(`Warning: invalid activity JSONL at line ${i + 1}; skipping.`);
			continue;
		}
		try {
			const event = normalizeActivityEvent(parsed, { now: () => new Date(typeof parsed.ts === "string" ? parsed.ts : Date.now()) });
			if (seen.has(event.id)) continue;
			seen.add(event.id);
			if (!matchesActivityFilter(event, opts.filter)) continue;
			events.push(event);
		} catch (error) {
			warn(`Warning: invalid activity event at line ${i + 1}: ${error instanceof Error ? error.message : String(error)}; skipping.`);
		}
	}
	if (opts.limit !== undefined && opts.limit >= 0) {
		if (opts.limit === 0) return [];
		if (events.length > opts.limit) return events.slice(-opts.limit);
	}
	return events;
}

export function tailActivityEvents(file: string, limit = DEFAULT_ACTIVITY_LIMIT, opts: Omit<ReadActivityOptions, "limit"> = {}): FlightdeckActivityEventV1[] {
	return readActivityEvents(file, { ...opts, limit });
}

export function matchesActivityFilter(event: FlightdeckActivityEventV1, filter?: string): boolean {
	const trimmed = filter?.trim();
	if (!trimmed) return true;
	const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
	for (const token of tokens) {
		const sep = token.includes("=") ? "=" : token.includes(":") ? ":" : "";
		if (!sep) {
			const haystack = [event.type, event.source, event.summary, event.entry_id ?? "", event.harness ?? ""].join("\n").toLowerCase();
			if (!haystack.includes(token.toLowerCase())) return false;
			continue;
		}
		const [rawKey, ...rawValueParts] = token.split(sep);
		const key = rawKey?.trim() ?? "";
		const value = rawValueParts.join(sep).trim();
		if (!key || !value) return false;
		if (String(filterValue(event, key) ?? "") !== value) return false;
	}
	return true;
}

function filterValue(event: FlightdeckActivityEventV1, key: string): unknown {
	switch (key) {
		case "id": return event.id;
		case "session":
		case "session_id": return event.session_id;
		case "source": return event.source;
		case "type": return event.type;
		case "severity": return event.severity;
		case "importance": return event.importance;
		case "entry":
		case "entry_id": return event.entry_id;
		case "entry_kind": return event.entry_kind;
		case "pane":
		case "pane_id": return event.pane_id;
		case "harness": return event.harness;
		case "pr":
		case "pr_number": return event.refs?.pr_number;
		case "issue":
		case "issue_id": return event.refs?.issue_id;
		case "task":
		case "task_id": return event.refs?.task_id;
		case "bg_task":
		case "bg_task_id": return event.refs?.bg_task_id;
		case "question":
		case "question_id": return event.refs?.question_id;
		default: return undefined;
	}
}
