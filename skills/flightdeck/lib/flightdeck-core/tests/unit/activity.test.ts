import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { appendActivityEvent } from "../../src/activity/append.ts";
import { formatActivityJsonl, formatActivityLine, formatActivityMarkdown } from "../../src/activity/format.ts";
import { activityArchivePathFromStatePath, activityPathFromStatePath } from "../../src/activity/paths.ts";
import { readActivityEvents, tailActivityEvents } from "../../src/activity/read.ts";
import { activityEventId, normalizeActivityEvent } from "../../src/activity/types.ts";
import { archiveState } from "../../src/state/master-state.ts";

let dir = "";
function path(name: string): string { return join(dir, name); }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fd-activity-")); });
afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true }); });

describe("activity event normalization", () => {
	test("fills schema defaults and stable id from natural key", () => {
		const event = normalizeActivityEvent({
			source: "flightdeck",
			summary: "Registered worker",
			type: "entry.registered",
		}, { naturalKey: "entry:WORKER", sessionId: "S1", now: () => new Date("2026-05-15T00:00:00Z") });
		expect(event).toMatchObject({
			importance: "normal",
			schema_version: 1,
			session_id: "S1",
			severity: "info",
			ts: "2026-05-15T00:00:00.000Z",
		});
		expect(event.id).toBe(activityEventId({ naturalKey: "entry:WORKER", sessionId: "S1", type: "entry.registered" }));
	});

	test("normalizes refs, links, noisy flag, and caps oversized details", () => {
		const event = normalizeActivityEvent({
			details: { huge: "x".repeat(128) },
			importance: "noisy",
			links: [{ label: "state", path: "tmp/state.json" }],
			refs: { pr_number: 12, issue_id: "FD-12" },
			severity: "success",
			source: "workflow",
			summary: "Decision recorded",
			type: "decision.recorded",
		}, { detailsMaxBytes: 32, naturalKey: "decision:1", now: () => new Date("2026-05-15T00:00:00Z") });
		expect(event.noisy).toBe(true);
		expect(event.links).toEqual([{ label: "state", path: "tmp/state.json" }]);
		expect(event.refs).toEqual({ issue_id: "FD-12", pr_number: 12 });
		expect(event.details).toEqual({ original_bytes: 139, truncated: true });
	});
});

describe("activity append/read", () => {
	test("append writes JSONL and dedupes duplicate ids", () => {
		const file = path("activity.jsonl");
		const first = appendActivityEvent(file, {
			entry_id: "A1",
			natural_key: "A1:registered",
			source: "flightdeck",
			summary: "A1 registered",
			type: "entry.registered",
		}, { sessionId: "S1", now: () => new Date("2026-05-15T00:00:00Z") });
		const second = appendActivityEvent(file, {
			entry_id: "A1",
			natural_key: "A1:registered",
			source: "flightdeck",
			summary: "A1 registered",
			type: "entry.registered",
		}, { sessionId: "S1", now: () => new Date("2026-05-15T00:00:01Z") });
		expect(first.appended).toBe(true);
		expect(second.appended).toBe(false);
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
		expect(readActivityEvents(file)).toEqual([first.event]);
	});

	test("append trims from the head until event and byte caps both pass", () => {
		const file = path("retained/activity.jsonl");
		for (let i = 0; i < 16; i += 1) {
			appendActivityEvent(file, {
				body: "x".repeat(120 + i * 10),
				natural_key: `event:${i}`,
				source: "flightdeck",
				summary: `event ${i}`,
				type: "entry.state_changed",
			}, { maxBytes: 1600, maxEvents: 100, sessionId: "S1", now: () => new Date(`2026-05-15T00:00:${String(i).padStart(2, "0")}Z`) });
		}
		const raw = readFileSync(file, "utf8");
		expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(1600);
		const events = raw.trim().split("\n").map((line) => JSON.parse(line) as { summary: string });
		expect(events.at(-1)?.summary).toBe("event 15");
		expect(events.map((event) => event.summary)).not.toContain("event 0");
	});

	test("reader skips invalid lines, dedupes, filters, and tails", () => {
		const file = path("activity.jsonl");
		const one = normalizeActivityEvent({ source: "daemon", summary: "daemon started", type: "daemon.started" }, { naturalKey: "daemon", now: () => new Date("2026-05-15T00:00:00Z") });
		const two = normalizeActivityEvent({ entry_id: "E1", severity: "warning", source: "daemon", summary: "subscriber died", type: "subscriber.dead" }, { naturalKey: "sub", now: () => new Date("2026-05-15T00:00:01Z") });
		writeFileSync(file, `${JSON.stringify(one)}\nnot-json\n${JSON.stringify(one)}\n${JSON.stringify(two)}\n`, "utf8");
		const warnings: string[] = [];
		expect(readActivityEvents(file, { warn: (msg) => warnings.push(msg) })).toEqual([one, two]);
		expect(warnings[0]).toContain("invalid activity JSONL");
		expect(readActivityEvents(file, { filter: "severity=warning" })).toEqual([two]);
		expect(tailActivityEvents(file, 1)).toEqual([two]);
	});

	test("formatters produce JSONL, markdown, and one-line output", () => {
		const event = normalizeActivityEvent({ entry_id: "E1", source: "workflow", summary: "Prompt answered", type: "question.answered" }, { naturalKey: "q1", now: () => new Date("2026-05-15T00:00:00Z") });
		expect(formatActivityLine(event)).toContain("question.answered entry=E1");
		expect(formatActivityJsonl([event])).toBe(`${JSON.stringify(event)}\n`);
		expect(formatActivityMarkdown([event])).toContain("`question.answered`");
	});

	test("concurrent appenders serialize under the activity lock", async () => {
		const file = path("concurrent/activity.jsonl");
		const appendModule = pathToFileURL(resolve(dirname(import.meta.path), "../../src/activity/append.ts")).href;
		const script = `import { appendActivityEvent } from ${JSON.stringify(appendModule)};\nappendActivityEvent(process.env.ACTIVITY_FILE, {source:"flightdeck", type:"entry.registered", summary:"E1 registered", entry_id:"E1", natural_key:"same"}, {sessionId:"S1", now:()=>new Date("2026-05-15T00:00:00Z")});`;
		const env = { ...(process.env as Record<string, string>), ACTIVITY_FILE: file };
		const procs = Array.from({ length: 8 }, () => Bun.spawn(["bun", "--eval", script], { env, stderr: "pipe", stdout: "pipe" }));
		const statuses = await Promise.all(procs.map((proc) => proc.exited));
		expect(statuses.every((status) => status === 0)).toBe(true);
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
	});
});

describe("activity archive", () => {
	function writeState(stateFile: string, terminatedAt: string): void {
		writeFileSync(stateFile, JSON.stringify({
			activity_path: activityPathFromStatePath(stateFile),
			activity_schema_version: 1,
			entries: {},
			terminated_at: terminatedAt,
		}), "utf8");
	}

	test("archive skips missing activity sidecar and clears activity pointers", () => {
		const stateFile = path("flightdeck-state-MISSING.json");
		const terminatedAt = "2026-05-15T00:01:00Z";
		writeState(stateFile, terminatedAt);
		const archive = archiveState(stateFile);
		expect(archive).not.toBeNull();
		const archived = JSON.parse(readFileSync(archive!, "utf8")) as { activity_archive_path?: unknown; activity_path?: unknown };
		expect(archived.activity_path).toBeUndefined();
		expect(archived.activity_archive_path).toBeUndefined();
		expect(existsSync(activityArchivePathFromStatePath(stateFile, terminatedAt))).toBe(false);
	});

	test("archive skips zero-byte activity sidecar and leaves no archive", () => {
		const stateFile = path("flightdeck-state-EMPTY.json");
		const terminatedAt = "2026-05-15T00:02:00Z";
		writeState(stateFile, terminatedAt);
		const activityFile = activityPathFromStatePath(stateFile);
		writeFileSync(activityFile, "", "utf8");
		const archive = archiveState(stateFile);
		expect(archive).not.toBeNull();
		const archived = JSON.parse(readFileSync(archive!, "utf8")) as { activity_archive_path?: unknown; activity_path?: unknown };
		expect(archived.activity_path).toBeUndefined();
		expect(archived.activity_archive_path).toBeUndefined();
		expect(existsSync(activityArchivePathFromStatePath(stateFile, terminatedAt))).toBe(false);
		expect(existsSync(activityFile)).toBe(true);
	});

	test("archive waits for an in-flight append and moves the completed line", async () => {
		const stateFile = path("flightdeck-state-RACE.json");
		const terminatedAt = "2026-05-15T00:03:00Z";
		writeState(stateFile, terminatedAt);
		const activityFile = activityPathFromStatePath(stateFile);
		const readyFile = path("activity-lock-ready");
		const appendModule = pathToFileURL(resolve(dirname(import.meta.path), "../../src/activity/append.ts")).href;
		const holder = Bun.spawn([
			"bash", "-c",
			"lock=\"$1\"; ready=\"$2\"; flock -x \"$lock\" bash -c 'printf ready > \"$1\"; sleep 0.5' _ \"$ready\"",
			"_", `${activityFile}.lock`, readyFile,
		], { stderr: "pipe", stdout: "pipe" });
		while (!existsSync(readyFile)) await Bun.sleep(5);
		const script = `import { appendActivityEvent } from ${JSON.stringify(appendModule)};\nappendActivityEvent(process.env.ACTIVITY_FILE, {source:"flightdeck", type:"entry.registered", summary:"race append", entry_id:"R1", natural_key:"race"}, {sessionId:"RACE", now:()=>new Date("2026-05-15T00:03:00Z")});`;
		const append = Bun.spawn(["bun", "--eval", script], { env: { ...(process.env as Record<string, string>), ACTIVITY_FILE: activityFile }, stderr: "pipe", stdout: "pipe" });
		await Bun.sleep(100);
		const archive = archiveState(stateFile);
		expect(await holder.exited).toBe(0);
		expect(await append.exited).toBe(0);
		expect(archive).not.toBeNull();
		const activityArchive = activityArchivePathFromStatePath(stateFile, terminatedAt);
		expect(existsSync(activityArchive)).toBe(true);
		const archivedLines = readFileSync(activityArchive, "utf8").trim().split("\n");
		expect(archivedLines).toHaveLength(1);
		expect(JSON.parse(archivedLines[0]!) as { summary: string }).toMatchObject({ summary: "race append" });
		expect(existsSync(activityFile)).toBe(false);
	});
});
