// Regression coverage for vstack#59: the daemon's run loop must
// reconcile its active subscriber set against the registry every
// FD_RECONCILE_INTERVAL_SEC seconds so entries spawned mid-session are
// picked up without a daemon restart.

import { describe, expect, test } from "bun:test";
import {
	RECONCILE_DEFAULT_INTERVAL_SEC,
	reconcileIntervalFromEnv,
	reconcileTrackedEntries,
	type ReconcileEntry,
} from "../../src/daemon/reconcile.ts";

interface LogLine { tag: string; msg: string }

function buildHarness(initialEntries: ReconcileEntry[]) {
	const active = new Set<string>();
	const spawnLog: ReconcileEntry[] = [];
	const reapLog: string[] = [];
	const logs: LogLine[] = [];
	let entriesNext: ReconcileEntry[] = [...initialEntries];
	const deps = {
		listTrackedEntries: () => entriesNext,
		activePaneIds: () => active.values(),
		spawnFor: (entry: ReconcileEntry) => {
			spawnLog.push(entry);
			if (!entry.harness) return { spawned: false, reason: "missing-harness" };
			active.add(entry.paneId);
			return { spawned: true };
		},
		reap: (paneId: string) => {
			reapLog.push(paneId);
			active.delete(paneId);
		},
		log: (tag: string, msg: string) => {
			logs.push({ tag, msg });
		},
	};
	return {
		deps,
		active,
		spawnLog,
		reapLog,
		logs,
		setEntries(next: ReconcileEntry[]): void {
			entriesNext = [...next];
		},
		seedActive(id: string): void {
			active.add(id);
		},
	};
}

describe("reconcileTrackedEntries (vstack#59)", () => {
	test("spawns subscribers for newly tracked entries", () => {
		const harness = buildHarness([
			{ paneId: "%10", harness: "pi", kind: "adhoc" },
		]);
		const result = reconcileTrackedEntries(harness.deps);
		expect(result.added).toEqual(["%10"]);
		expect(result.reaped).toEqual([]);
		expect(harness.spawnLog.length).toBe(1);
		expect(harness.spawnLog[0]?.paneId).toBe("%10");
		expect(harness.active.has("%10")).toBe(true);
	});

	test("mid-session: second entry appears later, spawn fires on next tick", () => {
		const harness = buildHarness([
			{ paneId: "%10", harness: "pi", kind: "adhoc" },
		]);
		reconcileTrackedEntries(harness.deps);
		expect(harness.spawnLog.length).toBe(1);
		harness.setEntries([
			{ paneId: "%10", harness: "pi", kind: "adhoc" },
			{ paneId: "%20", harness: "claude", kind: "adhoc" },
		]);
		const result = reconcileTrackedEntries(harness.deps);
		expect(result.added).toEqual(["%20"]);
		expect(harness.spawnLog.length).toBe(2);
		expect(harness.spawnLog[1]?.paneId).toBe("%20");
		expect(harness.spawnLog[1]?.harness).toBe("claude");
	});

	test("reaps subscribers for entries that disappeared from the registry", () => {
		const harness = buildHarness([
			{ paneId: "%10", harness: "pi" },
			{ paneId: "%20", harness: "claude" },
		]);
		reconcileTrackedEntries(harness.deps);
		harness.setEntries([{ paneId: "%10", harness: "pi" }]);
		const result = reconcileTrackedEntries(harness.deps);
		expect(result.reaped).toEqual(["%20"]);
		expect(harness.reapLog).toEqual(["%20"]);
		expect(harness.active.has("%20")).toBe(false);
	});

	test("idempotent: re-running with no changes adds=0 reaped=0", () => {
		const harness = buildHarness([
			{ paneId: "%10", harness: "pi" },
		]);
		reconcileTrackedEntries(harness.deps);
		const result = reconcileTrackedEntries(harness.deps);
		expect(result.added).toEqual([]);
		expect(result.reaped).toEqual([]);
	});

	test("logs '[reconcile] added=<n> reaped=<m>' on non-empty change set", () => {
		const harness = buildHarness([
			{ paneId: "%10", harness: "pi" },
		]);
		reconcileTrackedEntries(harness.deps);
		const reconcileLog = harness.logs.find((line) => line.tag === "reconcile");
		expect(reconcileLog).toBeDefined();
		expect(reconcileLog?.msg).toMatch(/added=1 reaped=0/);
		expect(reconcileLog?.msg).toContain("%10");
	});

	test("does not log [reconcile] when added=0 reaped=0 (steady state)", () => {
		const harness = buildHarness([{ paneId: "%10", harness: "pi" }]);
		harness.seedActive("%10");
		reconcileTrackedEntries(harness.deps);
		expect(harness.logs.find((line) => line.tag === "reconcile")).toBeUndefined();
	});

	test("entries without harness are skipped (logged as missing-harness)", () => {
		const harness = buildHarness([
			{ paneId: "%10", harness: "" },
		]);
		const result = reconcileTrackedEntries(harness.deps);
		expect(result.added).toEqual([]);
		expect(result.skipped[0]?.reason).toBe("missing-harness");
	});

	test("entries without pane_id are silently ignored", () => {
		const harness = buildHarness([
			{ paneId: "", harness: "pi" },
			{ paneId: "%30", harness: "pi" },
		]);
		const result = reconcileTrackedEntries(harness.deps);
		expect(result.added).toEqual(["%30"]);
	});

	test("listTrackedEntries throwing does not crash reconcile", () => {
		const logs: LogLine[] = [];
		const result = reconcileTrackedEntries({
			listTrackedEntries: () => { throw new Error("boom"); },
			activePaneIds: () => [],
			spawnFor: () => ({ spawned: true }),
			reap: () => undefined,
			log: (tag, msg) => logs.push({ tag, msg }),
		});
		expect(result.added).toEqual([]);
		expect(result.reaped).toEqual([]);
		expect(logs.find((line) => line.tag === "reconcile-error")).toBeDefined();
	});
});

describe("reconcileIntervalFromEnv", () => {
	test("defaults to RECONCILE_DEFAULT_INTERVAL_SEC when env is unset", () => {
		expect(reconcileIntervalFromEnv({} as NodeJS.ProcessEnv)).toBe(RECONCILE_DEFAULT_INTERVAL_SEC);
		expect(RECONCILE_DEFAULT_INTERVAL_SEC).toBe(5);
	});

	test("parses positive integer override", () => {
		expect(reconcileIntervalFromEnv({ FD_RECONCILE_INTERVAL_SEC: "12" } as any)).toBe(12);
	});

	test("ignores garbage and falls back to default", () => {
		expect(reconcileIntervalFromEnv({ FD_RECONCILE_INTERVAL_SEC: "" } as any)).toBe(RECONCILE_DEFAULT_INTERVAL_SEC);
		expect(reconcileIntervalFromEnv({ FD_RECONCILE_INTERVAL_SEC: "garbage" } as any)).toBe(RECONCILE_DEFAULT_INTERVAL_SEC);
		expect(reconcileIntervalFromEnv({ FD_RECONCILE_INTERVAL_SEC: "-3" } as any)).toBe(RECONCILE_DEFAULT_INTERVAL_SEC);
	});
});
