import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerPaneSupportTools } from "../extensions/subagent/pane-support-tools.js";
import type { PaneTaskRecord } from "../extensions/subagent/types.js";

interface CapturedTool {
	name: string;
	execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>;
}

function tempRuntime(): string {
	return mkdtempSync(join(tmpdir(), "pi-agents-steer-status-"));
}

function buildDeps(opts: {
	runtimeRoot: string;
	dashboardStatusForFn: ((status: any, kind: any) => any) | undefined;
	dashboardStatusForCallCount: { count: number };
	updateDashboardSpy: { calls: any[] };
}): { deps: Record<string, any>; capturedTools: CapturedTool[] } {
	const capturedTools: CapturedTool[] = [];
	const record: PaneTaskRecord = {
		taskId: "task-steer-1",
		agent: "planner",
		task: "Plan.",
		status: "running",
		paneId: "%42",
		createdAt: "2026-05-15T00:00:00.000Z",
	};
	const paneEntry = {
		paneId: "%42",
		sessionFile: join(opts.runtimeRoot, "sessions", "planner.jsonl"),
		cwd: opts.runtimeRoot,
	};
	const deps: Record<string, any> = {
		pi: {
			registerTool(tool: any) {
				capturedTools.push({ name: tool.name, execute: tool.execute });
			},
		},
		bridgeTargetArgs: () => [],
		backfillTaskSummaryFromTranscript: async (_r: string, rec: PaneTaskRecord) => ({ record: rec }),
		createFollowUpTask: async () => ({ taskId: "follow-up", outboxFile: "" }),
		dashboardStatusFor: opts.dashboardStatusForFn
			? (status: any, kind: any) => {
					opts.dashboardStatusForCallCount.count += 1;
					return opts.dashboardStatusForFn!(status, kind);
				}
			: undefined,
		emitSubagentEvent: () => {},
		ensurePaneBridgeMetadata: async () => undefined,
		execCapture: async () => ({ code: 0, stdout: "", stderr: "" }),
		formatSteeringForChild: (_agent: string, message: string) => `STEER:${message}`,
		formatTaskRecordResult: () => "",
		inferTaskRecordKind: () => "pane",
		isFollowUpDelivery: (mode: string) => mode === "follow-up",
		isTerminalTaskStatus: () => false,
		latestTaskRecord: () => record,
		paneExists: async () => true,
		paneSessionBelongsToRuntime: () => true,
		patchDashboard: () => {},
		pollPaneCompletions: async () => 0,
		queueSteeringFallback: async (runtimeRoot: string, agentName: string, message: string) => {
			const inbox = join(runtimeRoot, "inbox", agentName);
			mkdirSync(inbox, { recursive: true });
			const filePath = join(inbox, `steer-${Date.now()}.md`);
			writeFileSync(filePath, `STEER:${agentName}:${message}`, "utf-8");
			return filePath;
		},
		readPaneRegistry: async () => ({ planner: paneEntry }),
		readTaskRegistry: async () => ({ [record.taskId]: record }),
		refreshTaskDiagnostics: async (_r: string, rec: PaneTaskRecord) => ({ record: rec, diagnostics: [] }),
		taskNeedsSummaryBackfill: () => false,
		removeDashboardAgent: () => {},
		resolvePiBridgeBin: async () => undefined,
		runtimeSessionId: () => "session-test",
		sessionRuntimeDir: () => opts.runtimeRoot,
		steerDiagnostics: () => [],
		stopPersistentPane: async () => ({ agent: "planner", paneId: "%42", sessionFile: paneEntry.sessionFile }),
		updateDashboard: (item: any) => {
			opts.updateDashboardSpy.calls.push(item);
		},
		updateDashboardFromTaskRecord: () => {},
		persistRuntimeSnapshot: async () => {},
		waitForPaneIdle: async () => ({ text: "", details: {}, isError: false }),
	};
	return { deps, capturedTools };
}

function getSteerHandler(tools: CapturedTool[]): CapturedTool {
	const handler = tools.find((tool) => tool.name === "steer_subagent");
	assert.ok(handler, "steer_subagent must be registered");
	return handler;
}

test("steer_subagent delivers message when dashboardStatusFor is provided (regression vstack#62)", async () => {
	const runtimeRoot = tempRuntime();
	const callCounter = { count: 0 };
	const updateDashboardSpy = { calls: [] as any[] };
	const { deps, capturedTools } = buildDeps({
		runtimeRoot,
		dashboardStatusForFn: (status, _kind) => status,
		dashboardStatusForCallCount: callCounter,
		updateDashboardSpy,
	});
	registerPaneSupportTools(deps as any);
	const steer = getSteerHandler(capturedTools);

	const result = await steer.execute(
		"call-1",
		{ taskId: "task-steer-1", message: "please pivot" },
		undefined,
		undefined,
		{},
	);

	assert.equal(result.isError, undefined, "no error");
	assert.equal(callCounter.count, 1, "dashboardStatusFor invoked exactly once");
	assert.equal(updateDashboardSpy.calls.length, 1, "updateDashboard invoked exactly once");
	assert.equal(updateDashboardSpy.calls[0]?.status, "running");
	const fallbackFile = result.details?.fallbackFile;
	assert.ok(fallbackFile && existsSync(fallbackFile), "fallback inbox file written");
	const contents = readFileSync(fallbackFile, "utf-8");
	assert.ok(contents.includes("please pivot"), "steering message reaches inbox file");
});

test("steer_subagent still delivers message when dashboardStatusFor is missing (defensive guard)", async () => {
	const runtimeRoot = tempRuntime();
	const callCounter = { count: 0 };
	const updateDashboardSpy = { calls: [] as any[] };
	const { deps, capturedTools } = buildDeps({
		runtimeRoot,
		dashboardStatusForFn: undefined,
		dashboardStatusForCallCount: callCounter,
		updateDashboardSpy,
	});
	registerPaneSupportTools(deps as any);
	const steer = getSteerHandler(capturedTools);

	let threw = false;
	let result: any;
	try {
		result = await steer.execute(
			"call-2",
			{ taskId: "task-steer-1", message: "missing helper" },
			undefined,
			undefined,
			{},
		);
	} catch {
		threw = true;
	}
	assert.equal(threw, false, "steer must not throw when dashboardStatusFor is undefined");
	assert.equal(callCounter.count, 0, "dashboardStatusFor never invoked when missing");
	assert.equal(updateDashboardSpy.calls.length, 1, "updateDashboard still invoked with fallback status");
	assert.equal(updateDashboardSpy.calls[0]?.status, "running", "fallback uses raw record.status");
	const fallbackFile = result?.details?.fallbackFile;
	assert.ok(fallbackFile && existsSync(fallbackFile), "fallback inbox file still written");
	const contents = readFileSync(fallbackFile, "utf-8");
	assert.ok(contents.includes("missing helper"), "steering message still reaches inbox");
});
