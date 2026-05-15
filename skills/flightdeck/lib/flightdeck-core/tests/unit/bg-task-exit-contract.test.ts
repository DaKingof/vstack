// pi-bg-task-exit canonical contract. The TS constants in
// src/events/bg-task-exit.ts must stay in sync with the shared bash
// helper that the daemon subscriber sources (scripts/lib/
// daemon-bg-task-events.sh) and the tag must remain in the daemon's
// CANONICAL_TAGS allowlist. Drift here silently breaks wake routing.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	BG_TASK_EVENT_CUSTOM_TYPE,
	BG_TASK_EXIT_CLASSIFIER_TAG,
	BG_TASK_EXIT_EVENT_TYPE,
} from "../../src/events/bg-task-exit.ts";
import { isCanonicalTag } from "../../src/daemon/events.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BG_TASK_EVENTS_SH = resolve(HERE, "../../../../scripts/lib/daemon-bg-task-events.sh");
const SUBSCRIBERS_BASH = resolve(HERE, "../../../../scripts/lib/subscribers.bash");

function extractExportValue(source: string, name: string): string | null {
	const match = source.match(new RegExp(`(?:^|\\n)\\s*export\\s+${name}=\"([^\"]+)\"`));
	return match ? match[1]! : null;
}

describe("pi-bg-task-exit canonical contract", () => {
	const bgTaskBash = readFileSync(BG_TASK_EVENTS_SH, "utf8");

	test("BG_TASK_EVENT_CUSTOM_TYPE matches the bash subscriber export", () => {
		expect(extractExportValue(bgTaskBash, "BG_TASK_EVENT_CUSTOM_TYPE")).toBe(BG_TASK_EVENT_CUSTOM_TYPE);
	});

	test("BG_TASK_EXIT_EVENT_TYPE matches the bash subscriber export", () => {
		expect(extractExportValue(bgTaskBash, "BG_TASK_EXIT_EVENT_TYPE")).toBe(BG_TASK_EXIT_EVENT_TYPE);
	});

	test("BG_TASK_EXIT_CLASSIFIER_TAG matches the bash subscriber export", () => {
		expect(extractExportValue(bgTaskBash, "BG_TASK_EXIT_CLASSIFIER_TAG")).toBe(BG_TASK_EXIT_CLASSIFIER_TAG);
	});

	test("classifier tag is canonical in the TS daemon allowlist", () => {
		expect(isCanonicalTag(BG_TASK_EXIT_CLASSIFIER_TAG)).toBe(true);
	});

	test("shared subscriber sources the canonical bg-task helper", () => {
		const subscribersBash = readFileSync(SUBSCRIBERS_BASH, "utf8");
		expect(subscribersBash).toContain("daemon-bg-task-events.sh");
		expect(subscribersBash).toContain(BG_TASK_EVENT_CUSTOM_TYPE);
		expect(subscribersBash).toContain(BG_TASK_EXIT_EVENT_TYPE);
	});
});
