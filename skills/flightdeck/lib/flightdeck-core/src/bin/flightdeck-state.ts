#!/usr/bin/env bun
// CLI parity port of skills/flightdeck/scripts/flightdeck-state.
//
// Subcommands: init | get | set | append | increment | tracked-entries | write-entry | path | phase | archive | activity | master-busy

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendActivityEvent } from "../activity/append.ts";
import { formatActivityJsonl, formatActivityLine, formatActivityMarkdown } from "../activity/format.ts";
import { activityPathForSession } from "../activity/paths.ts";
import { readActivityEvents, tailActivityEvents } from "../activity/read.ts";
import {
	archiveState,
	getField,
	initState,
	normalizePath,
	resolveSession,
	resolveStateBase,
	statePath,
	updateState,
} from "../state/master-state.ts";
import { resolveProjectRoot } from "../shared/project.ts";
import {
	readTrackedEntries,
	validateDomainIssueId,
	validateEntryId,
} from "../state/tracked-entry.ts";
import type { FlightdeckStateLike, TrackedEntry } from "../state/types.ts";
import {
	fdBusyFile,
	fdResolveStateDir,
	fdSessionKeyFromId,
	fdSessionLock,
	fdWakePending,
} from "../paths/daemon.ts";
import { lockedAtomicWriteAndUnlink, lockedUnlink } from "../state/locking.ts";

function die(msg: string, code = 2): never {
	process.stderr.write(`${msg}\n`);
	process.exit(code);
}

function parseGlobalAndArgs(): { action: string; session: string; rest: string[] } {
	const args = process.argv.slice(2);
	const action = args.shift();
	if (!action) die("Usage: flightdeck-state <action> [args]");
	let session = "";
	const rest: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const a = args[i]!;
		if (a === "--session") { session = args[++i] ?? ""; continue; }
		if (a.startsWith("--session=")) { session = a.slice("--session=".length); continue; }
		rest.push(a);
	}
	return { action: action!, rest, session };
}

const { action, session: rawSession, rest } = parseGlobalAndArgs();
const session = resolveSession(rawSession);
const file = statePath(session);

switch (action) {
	case "path": {
		process.stdout.write(`${file}\n`);
		break;
	}
	case "init": {
		initState(file);
		break;
	}
	case "get": {
		if (rest.length < 1) die("Usage: get <jq-path>");
		if (!existsSync(file)) process.exit(1);
		process.stdout.write(getField(file, rest[0]!));
		break;
	}
	case "set": {
		if (rest.length < 2) die("Usage: set <field> <json-value>");
		const field = normalizePath(rest[0]!);
		updateState(file, `${field} = (${rest[1]})`);
		break;
	}
	case "append": {
		if (rest.length < 2) die("Usage: append <field> <json-value>");
		const field = normalizePath(rest[0]!);
		updateState(file, `${field} += [(${rest[1]})]`);
		break;
	}
	case "increment": {
		if (rest.length < 1) die("Usage: increment <field>");
		const field = normalizePath(rest[0]!);
		updateState(file, `${field} = ((${field} // 0) + 1)`);
		break;
	}
	case "tracked-entries": {
		if (!existsSync(file)) process.exit(1);
		const state = readStateJson();
		process.stdout.write(`${JSON.stringify(readTrackedEntries(state, { warn: warnLine }))}\n`);
		break;
	}
	case "write-entry": {
		if (rest.length < 2) die("Usage: write-entry <ENTRY_ID> <json-entry>");
		let entry: TrackedEntry;
		try {
			entry = JSON.parse(rest[1]!) as TrackedEntry;
		} catch {
			die("Error: invalid json-entry");
		}
		const entryId = validateEntryIdOrDie(rest[0]!, "entry id");
		const jsonEntryId = validateEntryIdOrDie(entry.id, "entry.id");
		if (jsonEntryId !== entryId) die(`Error: invalid entry.id: must match entry id ${entryId}`);
		const domainIssueId = validateDomainIssueIdOrDie(entry);
		entry.id = jsonEntryId;
		if (domainIssueId && entry.domain?.issue) entry.domain.issue.id = domainIssueId;
		updateState(file, writeTrackedEntryFilter(entryId, entry));
		break;
	}
	case "archive": {
		const ap = archiveState(file);
		if (ap) process.stdout.write(`${ap}\n`);
		break;
	}
	case "activity": {
		runActivity(rest);
		break;
	}
	case "phase": {
		if (rest.length < 1) die("Usage: phase <ISSUE_ID>");
		runPhase(rest[0]!);
		break;
	}
	case "master-busy": {
		if (rest.length < 1) die("Usage: master-busy <lock|unlock|check> [--master-pane <%N>] [--owner-pid <PID>]");
		runMasterBusy(rest);
		break;
	}
	default:
		die(`Unknown action: ${action}\nActions: init | get | set | append | increment | tracked-entries | write-entry | archive | activity | master-busy | path | phase`);
}

function writeTrackedEntryFilter(id: string, entry: TrackedEntry): string {
	const idJson = JSON.stringify(id);
	const entryJson = JSON.stringify(entry);
	return `.entries = ((.entries // {}) + {(${idJson}): ${entryJson}})`;
}

function readStateJson(): FlightdeckStateLike {
	return JSON.parse(readFileSync(file, "utf8")) as FlightdeckStateLike;
}

function warnLine(message: string): void {
	process.stderr.write(`${message}\n`);
}

function activityFile(): string {
	return activityPathForSession(session, resolveStateBase());
}

function runActivity(args: string[]): void {
	const sub = args[0];
	if (!sub) die("Usage: activity <path|append|tail|export> [args]");
	const activity = activityFile();
	switch (sub) {
		case "path": {
			process.stdout.write(`${activity}\n`);
			break;
		}
		case "append": {
			if (args.length < 2) die("Usage: activity append <json-event>");
			let payload: unknown;
			try {
				payload = JSON.parse(args[1]!);
			} catch {
				die("Error: invalid json-event");
			}
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) die("Error: json-event must be an object");
			const result = appendActivityEvent(activity, payload, { sessionId: session });
			process.stdout.write(`${JSON.stringify(result.event)}\n`);
			break;
		}
		case "tail": {
			const opts = parseActivityReadFlags(args.slice(1), { defaultFormat: "text", defaultLimit: 300 });
			const events = tailActivityEvents(activity, opts.limit, { filter: opts.filter, warn: warnLine });
			if (opts.format === "json") process.stdout.write(`${JSON.stringify(events)}\n`);
			else process.stdout.write(events.map(formatActivityLine).join("\n") + (events.length > 0 ? "\n" : ""));
			break;
		}
		case "export": {
			const opts = parseActivityReadFlags(args.slice(1), { defaultFormat: "jsonl" });
			const events = readActivityEvents(activity, { filter: opts.filter, warn: warnLine });
			if (opts.format === "markdown") process.stdout.write(formatActivityMarkdown(events));
			else process.stdout.write(formatActivityJsonl(events));
			break;
		}
		default:
			die("Usage: activity <path|append|tail|export> [args]");
	}
}

function parseActivityReadFlags(args: string[], defaults: { defaultFormat: "text" | "json" | "jsonl" | "markdown"; defaultLimit?: number }): { filter?: string; format: "text" | "json" | "jsonl" | "markdown"; limit: number } {
	let format = defaults.defaultFormat;
	let limit = defaults.defaultLimit ?? Number.MAX_SAFE_INTEGER;
	let filter: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--json") { format = "json"; continue; }
		if (arg === "--limit") { limit = parsePositiveInt(args[++i], "--limit"); continue; }
		if (arg.startsWith("--limit=")) { limit = parsePositiveInt(arg.slice("--limit=".length), "--limit"); continue; }
		if (arg === "--format") { format = parseActivityFormat(args[++i]); continue; }
		if (arg.startsWith("--format=")) { format = parseActivityFormat(arg.slice("--format=".length)); continue; }
		if (arg === "--filter") { filter = args[++i] ?? ""; continue; }
		if (arg.startsWith("--filter=")) { filter = arg.slice("--filter=".length); continue; }
		die(`Unknown activity flag: ${arg}`);
	}
	return { filter, format, limit };
}

function parseActivityFormat(value: string | undefined): "jsonl" | "markdown" {
	if (value === "jsonl" || value === "markdown") return value;
	die("Error: --format must be jsonl or markdown");
}

function parsePositiveInt(value: string | undefined, label: string): number {
	if (!value || !/^[0-9]+$/.test(value)) die(`Error: ${label} must be a non-negative integer`);
	return Number.parseInt(value, 10);
}

function validateEntryIdOrDie(value: unknown, label: string): string {
	try {
		return validateEntryId(value, label);
	} catch (error) {
		die(`Error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function validateDomainIssueIdOrDie(entry: TrackedEntry): string | undefined {
	try {
		return validateDomainIssueId(entry);
	} catch (error) {
		die(`Error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function runPhase(issue: string): void {
	const root = resolveProjectRoot();
	const orchDir = process.env.ORCH_STATE_DIR && process.env.ORCH_STATE_DIR.trim() ? process.env.ORCH_STATE_DIR.trim() : "tmp";
	const orchFile = join(root, orchDir, `workflow-state-${issue}.json`);
	if (existsSync(orchFile)) {
		let obj: Record<string, unknown> = {};
		try { obj = JSON.parse(readFileSync(orchFile, "utf8")); } catch { /* fall through */ }
		const cycles = toInt(obj.cycles, 0);
		const reviewers = Array.isArray(obj.review_agents) ? obj.review_agents.length : 0;
		const escalated = Array.isArray(obj.escalated_items) ? obj.escalated_items.length : 0;
		const prReview = toInt((obj.pr_comment_review as { iterations?: unknown } | undefined)?.iterations, 0);
		const childCount = obj.child_sessions && typeof obj.child_sessions === "object" ? Object.keys(obj.child_sessions as Record<string, unknown>).length : 0;
		const parts: string[] = [];
		if (cycles > 0) parts.push(`cycle=${cycles}`);
		if (reviewers > 0) parts.push(`reviewers=${reviewers}`);
		if (prReview > 0) parts.push(`pr-review=${prReview}`);
		if (childCount > 0) parts.push(`children=${childCount}`);
		if (escalated > 0) parts.push(`escalated=${escalated}`);
		process.stdout.write(`${parts.length === 0 ? "pre-cycle" : parts.join(" ")}\n`);
		return;
	}
	if (existsSync(file)) {
		const fd = getField(file, `.entries["${issue}"].state // empty`).trim();
		if (fd) {
			process.stdout.write(`fd:${fd}\n`);
			return;
		}
	}
	process.stdout.write("unknown\n");
}

function toInt(v: unknown, fallback: number): number {
	if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
	if (typeof v === "string" && /^-?\d+$/.test(v)) return Number.parseInt(v, 10);
	return fallback;
}

function runMasterBusy(args: string[]): void {
	const sub = args[0]!;
	const sidRes = spawnSync("tmux", ["display-message", "-p", "-t", session, "#{session_id}"], { encoding: "utf8" });
	const sid = (sidRes.stdout ?? "").trim();
	if (!sid) die(`Error: cannot resolve session_id for ${session}`);
	const fdDir = fdResolveStateDir();
	const sidKey = fdSessionKeyFromId(sid);
	const busyFile = fdBusyFile(fdDir, sidKey);
	const sessionLock = fdSessionLock(fdDir, sidKey);
	switch (sub) {
		case "lock": {
			let masterPane = "";
			let ownerPid = "";
			for (let i = 1; i < args.length; i += 1) {
				if (args[i] === "--master-pane") masterPane = args[++i] ?? "";
				else if (args[i] === "--owner-pid") ownerPid = args[++i] ?? "";
			}
			if (!masterPane) {
				masterPane = (process.env.TMUX_PANE ?? "").trim();
				if (!masterPane) {
					const r = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], { encoding: "utf8" });
					masterPane = (r.stdout ?? "").trim();
				}
			}
			if (!masterPane) die("Error: cannot resolve master pane id");
			const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
			const wakePending = fdWakePending(fdDir, sidKey);
			const payload = ownerPid && /^[1-9][0-9]*$/.test(ownerPid)
				? { pid: Number.parseInt(ownerPid, 10), master_pane_id: masterPane, started_at: startedAt }
				: { master_pane_id: masterPane, started_at: startedAt };
			// Hold the daemon SESSION_LOCK across the busy-file publish AND
			// the WAKE_PENDING clear. This matches the bash contract that
			// keeps the daemon's append_event / wake_master paths from
			// racing master's turn-start handoff.
			const r = lockedAtomicWriteAndUnlink(sessionLock, busyFile, JSON.stringify(payload), wakePending);
			if (r.status !== 0) {
				process.stderr.write(r.stderr || "");
				process.exit(r.status ?? 1);
			}
			break;
		}
		case "unlock": {
			// Release matching the bash `rm -f $BUSY_FILE` under session lock.
			const r = lockedUnlink(sessionLock, busyFile);
			if (r.status !== 0) {
				process.stderr.write(r.stderr || "");
				process.exit(r.status ?? 1);
			}
			break;
		}
		case "check": {
			if (existsSync(busyFile)) {
				process.stdout.write(readFileSync(busyFile, "utf8"));
				break;
			}
			process.exit(1);
		}
		default:
			die("Usage: master-busy <lock|unlock|check>");
	}
}
