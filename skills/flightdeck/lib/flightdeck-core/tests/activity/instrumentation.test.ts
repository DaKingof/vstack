import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../../../../scripts/pane-registry");
const FLIGHTDECK_STATE = resolve(HERE, "../../../../scripts/flightdeck-state");
const SHIM_DIR = resolve(HERE, "../parity/tmux-shim");
const SESSION = "test-session";

interface ShimPane {
	window_id: string;
	window_name: string;
	path: string;
	window_index: number;
	pane_index: number;
}

interface ShimState {
	session: string;
	panes: Record<string, ShimPane>;
	windows: Record<string, { name: string; index: number }>;
}

interface ActivityEvent {
	type: string;
	severity: string;
	importance: string;
	summary: string;
	entry_id?: string;
	entry_title?: string;
	entry_kind?: string;
	pane_id?: string;
	harness?: string;
	refs?: Record<string, unknown>;
	details?: Record<string, unknown>;
}

let repo = "";
let shimState = "";

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "fd-activity-instrument-"));
	spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	spawnSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], {
		env: { ...process.env, GIT_AUTHOR_EMAIL: "t@t", GIT_AUTHOR_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_NAME: "t" },
	});
	shimState = writeShimState({ panes: {}, session: SESSION, windows: {} });
});

afterEach(() => {
	if (repo && existsSync(repo)) rmSync(repo, { force: true, recursive: true });
});

function writeShimState(state: ShimState): string {
	const path = join(repo, "shim-state.json");
	writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
	return path;
}

function registryEnv(): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	env.FLIGHTDECK_STATE_DIR = "tmp";
	env.PATH = `${SHIM_DIR}:${env.PATH ?? ""}`;
	env.TMUX = env.TMUX || "shim";
	env.TMUX_PANE = env.TMUX_PANE || "%master";
	env.TMUX_PARITY_SESSION = SESSION;
	env.TMUX_SHIM_STATE = shimState;
	return env;
}

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const r = spawnSync(SCRIPT, args, { cwd: repo, encoding: "utf8", env: registryEnv() });
	return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

function runFlightdeckState(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const env = registryEnv();
	const r = spawnSync(FLIGHTDECK_STATE, [args[0]!, "--session", SESSION, ...args.slice(1)], { cwd: repo, encoding: "utf8", env });
	return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

function activityPath(): string {
	return join(repo, "tmp", `flightdeck-activity-${SESSION}.jsonl`);
}

function statePath(): string {
	return join(repo, "tmp", `flightdeck-state-${SESSION}.json`);
}

function events(): ActivityEvent[] {
	const file = activityPath();
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ActivityEvent);
}

function eventsOf(type: string): ActivityEvent[] {
	return events().filter((event) => event.type === type);
}

function initEntry(id = "E1", extra: string[] = []): void {
	const result = run(["init-entry", id, "--title", "Example Entry", "--kind", "adhoc", "--cwd", "/tmp/example", "--window", "example", "--harness", "pi", "--pane-id", "%101", ...extra]);
	expect(result.status).toBe(0);
}

describe("pane-registry activity instrumentation", () => {
	test("init-entry emits one registered event with entry context", () => {
		initEntry("REG-1", ["--kind", "workflow"]);
		const registered = eventsOf("entry.registered");
		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({
			entry_id: "REG-1",
			entry_kind: "workflow",
			entry_title: "Example Entry",
			harness: "pi",
			importance: "important",
			pane_id: "%101",
			severity: "info",
			summary: "workflow REG-1 registered: Example Entry",
		});
	});

	test("set-state emits state change once and skips no-op transitions", () => {
		initEntry("STATE-1");
		expect(run(["set-state", "STATE-1", "ready"]).status).toBe(0);
		expect(run(["set-state", "STATE-1", "ready"]).status).toBe(0);
		const changes = eventsOf("entry.state_changed").filter((event) => event.entry_id === "STATE-1" && event.details?.new === "ready");
		expect(changes).toHaveLength(1);
		expect(changes[0]?.details).toMatchObject({ new: "ready", old: "waiting" });
		expect(changes[0]?.importance).toBe("normal");
	});

	test("set-substate emits noisy state_changed with parent state", () => {
		initEntry("SUB-1");
		expect(run(["set-substate", "SUB-1", "scope-creep-detected"]).status).toBe(0);
		const changes = eventsOf("entry.state_changed").filter((event) => event.entry_id === "SUB-1" && event.details?.substate === "scope-creep-detected");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ importance: "noisy", severity: "info", summary: "SUB-1 substate: scope-creep-detected" });
		expect(changes[0]?.details).toMatchObject({ parentState: "waiting", substate: "scope-creep-detected" });
	});

	test("log-decision emits info and warning decision events", () => {
		initEntry("DEC-1");
		expect(run(["log-decision", "DEC-1", "merge-now", "Approved merge"]).status).toBe(0);
		expect(run(["log-decision", "DEC-1", "bot-review", "BLOCKED: missing approval"]).status).toBe(0);
		expect(run(["log-decision", "DEC-1", "scope", "ESCALATED: needs operator"]).status).toBe(0);
		const decisions = eventsOf("decision.recorded").filter((event) => event.entry_id === "DEC-1");
		expect(decisions).toHaveLength(3);
		expect(decisions[0]).toMatchObject({ importance: "important", severity: "info", summary: "Approved merge" });
		expect(decisions[1]).toMatchObject({ importance: "important", severity: "warning", summary: "BLOCKED: missing approval" });
		expect(decisions[2]).toMatchObject({ importance: "important", severity: "warning", summary: "ESCALATED: needs operator" });
	});

	test("teardown-entry emits terminal completed cancelled and dead events", () => {
		const cases = [
			["DONE-1", "complete", "entry.completed", "success"],
			["CANCEL-1", "cancelled", "entry.cancelled", "warning"],
			["DEAD-1", "aborted", "entry.dead", "error"],
		] as const;
		for (const [id, state, type, severity] of cases) {
			initEntry(id, ["--pane-id", `%${id}`]);
			expect(run(["set-state", id, state]).status).toBe(0);
			expect(run(["teardown-entry", id]).status).toBe(0);
			const terminal = eventsOf(type).filter((event) => event.entry_id === id);
			expect(terminal).toHaveLength(1);
			expect(terminal[0]).toMatchObject({ importance: "important", severity });
		}
	});

	test("teardown-entry emits terminal event after live pane kill succeeds", () => {
		shimState = writeShimState({
			panes: { "%200": { pane_index: 0, path: "/tmp/live", window_id: "@20", window_index: 1, window_name: "live-window" } },
			session: SESSION,
			windows: { "@20": { index: 1, name: "live-window" } },
		});
		expect(run(["init-entry", "LIVE-1", "--title", "Live", "--kind", "adhoc", "--cwd", "/tmp/live", "--window", "live-window", "--harness", "pi", "--pane-id", "%200", "--pane-target", `${SESSION}:1.0`]).status).toBe(0);
		expect(run(["set-state", "LIVE-1", "complete"]).status).toBe(0);
		expect(run(["teardown-entry", "LIVE-1"]).status).toBe(0);
		const terminal = eventsOf("entry.completed").filter((event) => event.entry_id === "LIVE-1");
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({ importance: "important", severity: "success" });
		expect(terminal[0]?.details).toMatchObject({ teardown: "killed" });
		expect(JSON.parse(readFileSync(shimState, "utf8")).panes["%200"]).toBeUndefined();
	});

	test("reconcile stale pane drops row and emits entry.dead", () => {
		initEntry("STALE-1", ["--pane-id", "%999"]);
		expect(run(["reconcile"]).status).toBe(0);
		const dead = eventsOf("entry.dead").filter((event) => event.entry_id === "STALE-1");
		expect(dead).toHaveLength(1);
		expect(dead[0]).toMatchObject({ importance: "important", severity: "warning" });
		expect(dead[0]?.details).toMatchObject({ reason: "reconcile-stale-pane" });
	});

	test("reconcile drift emits daemon.warning without dropping row", () => {
		shimState = writeShimState({
			panes: { "%500": { pane_index: 0, path: "/tmp/other", window_id: "@50", window_index: 1, window_name: "other-window" } },
			session: SESSION,
			windows: { "@50": { index: 1, name: "other-window" } },
		});
		expect(run(["init-entry", "DRIFT-1", "--title", "Drift", "--kind", "adhoc", "--cwd", "/tmp/original", "--window", "original", "--harness", "pi", "--pane-target", `${SESSION}:1.0`]).status).toBe(0);
		expect(run(["set", "DRIFT-1", "pane_id", "null"]).status).toBe(0);
		expect(run(["reconcile"]).status).toBe(0);
		const warnings = eventsOf("daemon.warning").filter((event) => event.entry_id === "DRIFT-1");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.summary).toContain("reconcile drift: DRIFT-1");
		expect(JSON.parse(run(["get", "DRIFT-1"]).stdout).pane_id).toBeNull();
	});

	test("direct flightdeck-state set emits state_changed once and skips no-op", () => {
		mkdirSync(join(repo, "tmp"), { recursive: true });
		writeFileSync(statePath(), JSON.stringify({
			activity_path: activityPath(),
			activity_schema_version: 1,
			entries: {
				"DIRECT-1": { id: "DIRECT-1", kind: "adhoc", state: "waiting", title: "Direct", window: "direct", harness: "pi", pane_id: "%303" },
			},
			session_id: SESSION,
		}), "utf8");
		expect(runFlightdeckState(["set", `.entries[\"DIRECT-1\"].state`, '"ready"']).status).toBe(0);
		expect(runFlightdeckState(["set", `.entries[\"DIRECT-1\"].state`, '"ready"']).status).toBe(0);
		const changes = eventsOf("entry.state_changed").filter((event) => event.entry_id === "DIRECT-1" && event.details?.new === "ready");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ entry_kind: "adhoc", entry_title: "Direct", harness: "pi", pane_id: "%303" });
		expect(changes[0]?.details).toMatchObject({ new: "ready", old: "waiting" });
	});

	test("activity disabled succeeds silently without creating activity JSONL", () => {
		mkdirSync(join(repo, "tmp"), { recursive: true });
		writeFileSync(statePath(), JSON.stringify({
			entries: {
				"DISABLED-1": { id: "DISABLED-1", kind: "adhoc", state: "waiting", title: "Disabled", window: "disabled", harness: "pi" },
			},
			session_id: SESSION,
		}), "utf8");
		const result = run(["set-state", "DISABLED-1", "ready"]);
		expect(result.status).toBe(0);
		expect(existsSync(activityPath())).toBe(false);
	});
});
