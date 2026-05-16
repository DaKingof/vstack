import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { appendActivityEvent } from "../../src/activity/append.ts";
import { formatActivityJsonl, formatActivityLine, formatActivityMarkdown } from "../../src/activity/format.ts";
import { readActivityEvents, tailActivityEvents } from "../../src/activity/read.ts";
import { activityEventId, normalizeActivityEvent } from "../../src/activity/types.ts";

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
