import { existsSync, readFileSync } from "node:fs";

import {
	DEFAULT_ACTIVITY_LIMIT,
	normalizeActivityEvent,
	type ActivityEventInput,
	type FlightdeckActivityEventV1,
} from "./types.ts";

export class ActivityFilterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActivityFilterError";
	}
}

export interface ReadActivityOptions {
	limit?: number;
	filter?: string;
	warn?: (message: string) => void;
}

export interface ActivityFilterClause {
	key: "type" | "severity" | "importance" | "entry" | "entry_id" | "harness" | "source";
	op: "=" | "!=";
	value: string;
}

const ALLOWED_FILTER_KEYS = new Set<ActivityFilterClause["key"]>(["type", "severity", "importance", "entry", "entry_id", "harness", "source"]);

export function readActivityEvents(file: string, opts: ReadActivityOptions = {}): FlightdeckActivityEventV1[] {
	const filter = parseActivityFilter(opts.filter);
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
			if (!matchesActivityFilterClauses(event, filter)) continue;
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

export function readActivityJsonlLines(file: string, opts: ReadActivityOptions = {}): string[] {
	const filter = parseActivityFilter(opts.filter);
	if (!existsSync(file)) return [];
	const warn = opts.warn ?? (() => undefined);
	const lines = readFileSync(file, "utf8").split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const rawLine = lines[i]!;
		const line = rawLine.trim();
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
			if (!matchesActivityFilterClauses(event, filter)) continue;
			out.push(rawLine);
		} catch (error) {
			warn(`Warning: invalid activity event at line ${i + 1}: ${error instanceof Error ? error.message : String(error)}; skipping.`);
		}
	}
	if (opts.limit !== undefined && opts.limit >= 0) {
		if (opts.limit === 0) return [];
		if (out.length > opts.limit) return out.slice(-opts.limit);
	}
	return out;
}

export function tailActivityEvents(file: string, limit = DEFAULT_ACTIVITY_LIMIT, opts: Omit<ReadActivityOptions, "limit"> = {}): FlightdeckActivityEventV1[] {
	return readActivityEvents(file, { ...opts, limit });
}

export function parseActivityFilter(filter?: string): ActivityFilterClause[] {
	const trimmed = filter?.trim();
	if (!trimmed) return [];
	return trimmed.split(",").map((rawToken) => {
		const token = rawToken.trim();
		if (!token) throw new ActivityFilterError("invalid activity filter: empty clause");
		const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(!=|=)\s*(.+)$/);
		if (!match) throw new ActivityFilterError(`invalid activity filter clause: ${token}`);
		const key = match[1] as ActivityFilterClause["key"];
		const op = match[2] as ActivityFilterClause["op"];
		const value = match[3]!.trim();
		if (!ALLOWED_FILTER_KEYS.has(key)) throw new ActivityFilterError(`invalid activity filter key: ${key}`);
		if (!value) throw new ActivityFilterError(`invalid activity filter value for ${key}`);
		return { key, op, value };
	});
}

export function matchesActivityFilter(event: FlightdeckActivityEventV1, filter?: string): boolean {
	return matchesActivityFilterClauses(event, parseActivityFilter(filter));
}

function matchesActivityFilterClauses(event: FlightdeckActivityEventV1, clauses: ActivityFilterClause[]): boolean {
	for (const clause of clauses) {
		const actual = String(filterValue(event, clause.key) ?? "");
		if (clause.op === "=" && actual !== clause.value) return false;
		if (clause.op === "!=" && actual === clause.value) return false;
	}
	return true;
}

function filterValue(event: FlightdeckActivityEventV1, key: ActivityFilterClause["key"]): unknown {
	switch (key) {
		case "source": return event.source;
		case "type": return event.type;
		case "severity": return event.severity;
		case "importance": return event.importance;
		case "entry":
		case "entry_id": return event.entry_id;
		case "harness": return event.harness;
	}
}
